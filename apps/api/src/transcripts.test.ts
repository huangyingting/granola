import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Database } from '@windows-ai-notes/db';
import { exportMeeting } from '@windows-ai-notes/contracts/content';
import { transcriptPageSchema } from '@windows-ai-notes/contracts/server';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'paged PostgreSQL transcript storage and HTTP exports',
  () => {
    let admin: Database;
    let db: Database;
    let app: Awaited<ReturnType<typeof createServer>>;
    const schema = `notes_transcripts_${randomUUID().replaceAll('-', '')}`;
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    });
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function fixture(count = 1377, text = 'Synthetic immutable speech.') {
      const subject = randomUUID();
      const user = await db.provision(
        'urn:windows-ai-notes:development',
        subject,
      );
      const document = await db.createDocument(
        user.user_id,
        {
          workspace_id: user.workspace_id,
          title: 'Paged meeting',
          notes: 'Written notes.',
        },
        randomUUID(),
      );
      const segments = Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        start_ms: index * 1000,
        end_ms: index * 1000 + 999,
        text: `${index}: ${text}`,
      }));
      await db.transaction((tx) =>
        db.transcripts.write(
          tx,
          user.user_id,
          document.id,
          0,
          'azure_speech_fast',
          segments,
        ),
      );
      const headers = { 'x-dev-subject': subject };
      const get = (suffix = '?revision=1&offset=0') =>
        app.inject({
          url: `/v1/documents/${document.id}/transcript/pages${suffix}`,
          headers,
        });
      return { user, document, segments, headers, get };
    }
    it('retrieves every stable segment across bounded immutable pages and rejects silent legacy truncation', async () => {
      const f = await fixture();
      const found = [];
      let offset = 0;
      while (true) {
        const response = await f.get(`?revision=1&offset=${offset}`);
        expect(response.statusCode).toBe(200);
        const page = transcriptPageSchema.parse(response.json());
        expect(page).toMatchObject({
          document_id: f.document.id,
          revision: 1,
          total_segments: f.segments.length,
          offset,
        });
        found.push(...page.segments);
        if (!page.has_more) break;
        offset += page.segments.length;
      }
      expect(found).toEqual(f.segments);
      const legacy = await app.inject({
        url: `/v1/documents/${f.document.id}/transcript`,
        headers: f.headers,
      });
      expect(legacy.statusCode).toBe(413);
      expect(legacy.json().code).toBe('transcript_pagination_required');
      expect((await f.get('?revision=1&offset=1377')).json()).toMatchObject({
        segments: [],
        has_more: false,
      });
      for (const query of [
        '?revision=1&offset=1378',
        '?revision=1&offset=-1',
        '?revision=1&offset=1.5',
        '?revision=1&offset=0&limit=1000',
      ])
        expect((await f.get(query)).statusCode).toBe(400);
      expect((await f.get('?revision=2')).statusCode).toBe(404);
    });
    it('bounds Unicode bytes without skipping page boundaries and preserves mixed-case segment IDs', async () => {
      const f = await fixture(13, '中'.repeat(9900));
      const first = transcriptPageSchema.parse((await f.get()).json());
      expect(first.segments).toHaveLength(4);
      const second = transcriptPageSchema.parse(
        (await f.get('?revision=1&offset=4')).json(),
      );
      expect([...first.segments, ...second.segments]).toEqual(
        f.segments.slice(0, 8),
      );
      const id = randomUUID().toUpperCase();
      await db.editTranscript(f.user.user_id, f.document.id, 1, [
        { id, start_ms: 0, end_ms: 1, text: 'Uppercase identity.' },
      ]);
      expect(
        (await db.transcripts.page(f.user.user_id, f.document.id, 2))
          .segments[0]!.id,
      ).toBe(id);
    });
    it('pins old pages after manual edits and fences stale publication without partial rows or sync changes', async () => {
      const f = await fixture(101);
      await db.editTranscript(f.user.user_id, f.document.id, 1, [
        { id: randomUUID(), start_ms: 0, end_ms: 1, text: 'Manual revision.' },
      ]);
      expect((await f.get('?revision=1&offset=50')).json()).toMatchObject({
        revision: 1,
        total_segments: 101,
        segments: f.segments.slice(50, 100),
      });
      await expect(
        db.transaction((tx) =>
          db.transcripts.write(
            tx,
            f.user.user_id,
            f.document.id,
            1,
            'azure_speech_fast',
            f.segments,
          ),
        ),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      expect((await f.get('')).json()).toMatchObject({
        revision: 2,
        total_segments: 1,
        segments: [{ text: 'Manual revision.' }],
      });
      expect(
        (
          await db.pool.query(
            'SELECT count(*)::integer count FROM transcript_revisions WHERE document_id=$1',
            [f.document.id],
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it('authorizes every page for owner, membership and deletion, and cascades segment erasure', async () => {
      const f = await fixture(51);
      const other = await db.provision(
        'urn:windows-ai-notes:development',
        randomUUID(),
        f.user.workspace_id,
      );
      await expect(
        db.transcripts.page(other.user_id, f.document.id, 1, 50),
      ).rejects.toMatchObject({ code: 'document_not_found' });
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
        [f.user.workspace_id, f.user.user_id],
      );
      expect((await f.get('?revision=1&offset=50')).statusCode).toBe(404);
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',
        [f.user.workspace_id, f.user.user_id],
      );
      await db.deleteDocument(f.user.user_id, f.document.id);
      expect((await f.get('?revision=1&offset=50')).statusCode).toBe(404);
      expect(
        (
          await db.pool.query(
            'SELECT count(*)::integer count FROM transcript_segments WHERE document_id=$1',
            [f.document.id],
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it('streams all transcript evidence in both export formats without expanding summary context', async () => {
      const f = await fixture();
      for (const format of ['text', 'markdown'] as const) {
        const response = await app.inject({
          url: `/v1/documents/${f.document.id}/export?format=${format}`,
          headers: f.headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(
          exportMeeting({ ...f.document, segments: f.segments }, format),
        );
      }
      const response = await app.inject({
        method: 'POST',
        url: `/v1/documents/${f.document.id}/summary-runs`,
        headers: { ...f.headers, 'idempotency-key': randomUUID() },
        payload: { note_revision: 1, transcript_revision: 1 },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().code).toBe('context_too_large');
    });
  },
);
