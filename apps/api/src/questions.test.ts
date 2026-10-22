import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Database } from '@windows-ai-notes/db';
import {
  QUESTION_CONTEXT_BYTES,
  questionEvidenceSchema,
  type QuestionRequest,
} from '@windows-ai-notes/contracts/questions';
import type { Segment } from '@windows-ai-notes/contracts/server';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'authorized current-meeting question evidence',
  { timeout: 30_000 },
  () => {
    const schema = `notes_questions_${randomUUID().replaceAll('-', '')}`;
    let admin: Database, db: Database;
    let actor: { user_id: string; workspace_id: string };
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
    });
    beforeEach(async () => {
      await db.pool.query('TRUNCATE users,workspaces CASCADE');
      actor = await db.provision(
        'urn:windows-ai-notes:development',
        randomUUID(),
      );
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function source(count = 3, notes = 'Mira owns the checklist.') {
      const document = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic question evidence',
          notes,
        },
        randomUUID(),
      );
      const segments: Segment[] = Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        start_ms: index * 1000,
        end_ms: index * 1000 + 800,
        text: `Synthetic meeting discussion ${index}. No launch decision in this segment.`,
      }));
      if (count)
        await db.transaction((tx) =>
          db.transcripts.write(
            tx,
            actor.user_id,
            document.id,
            0,
            'manual',
            segments,
          ),
        );
      const request: QuestionRequest = {
        note_revision: 1,
        transcript_revision: count ? 1 : 0,
        language: 'en',
        question: 'Who owns the checklist?',
      };
      return { document, segments, request };
    }
    async function replace(id: string, segments: Segment[]) {
      await db.transaction((tx) =>
        db.transcripts.write(tx, actor.user_id, id, 1, 'manual', segments),
      );
    }
    it('uses all authorized current notes and transcript when the complete serialized context fits', async () => {
      const { document, segments, request } = await source();
      const result = await db.questions.evidence(
        actor.user_id,
        document.id,
        request,
      );
      expect(result.mode).toBe('full');
      expect(result.units).toHaveLength(4);
      expect(result.units[0]!.text).toBe(document.notes);
      expect(result.units.slice(1).map((unit) => unit.citation.id)).toEqual(
        segments.map((segment) => segment.id),
      );
      expect(
        result.units.slice(1).map((unit) => [unit.start_ms, unit.end_ms]),
      ).toEqual(segments.map((segment) => [segment.start_ms, segment.end_ms]));
      expect(questionEvidenceSchema.parse(result)).toEqual(result);
    });
    it('finds a late Chinese match and immediate time-neighbours without loading the legacy full transcript', async () => {
      const { document, segments, request } = await source(
        1101,
        'Human note only.',
      );
      segments[1099]!.text = '预算已批准，负责人为林，额度为一万元。';
      await replace(document.id, segments);
      const legacy = vi.spyOn(db.transcripts, 'legacy');
      const result = await db.questions.evidence(actor.user_id, document.id, {
        ...request,
        transcript_revision: 2,
        language: 'zh',
        question: '请问预算是多少？',
      });
      expect(result.mode).toBe('retrieved');
      expect(legacy).not.toHaveBeenCalled();
      expect(
        result.units.some((unit) => unit.citation.id === segments[1099]!.id),
      ).toBe(true);
      expect(
        result.units.some((unit) => unit.citation.id === segments[1098]!.id),
      ).toBe(true);
      expect(
        result.units.some((unit) => unit.citation.id === segments[1100]!.id),
      ).toBe(true);
      expect(
        result.units.some((unit) => unit.citation.id === segments[0]!.id),
      ).toBe(false);
      expect(result.units.every((unit) => unit.citation.revision === 2)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        QUESTION_CONTEXT_BYTES,
      );
    });
    it('retrieves notes too, preserves exact UTF-16 offsets, and handles a keyword spanning piece boundaries', async () => {
      const notes =
        'x'.repeat(3068) +
        ' checklist budget approved. ' +
        '😀记录'.repeat(8500);
      const { document, request } = await source(0, notes);
      const result = await db.questions.evidence(actor.user_id, document.id, {
        ...request,
        question: 'Was the checklist budget approved?',
      });
      expect(result.mode).toBe('retrieved');
      expect(
        result.units.some((unit) =>
          unit.text.includes('checklist budget approved'),
        ),
      ).toBe(true);
      expect(
        result.units.every(
          (unit) =>
            unit.citation.source === 'note' &&
            unit.text === notes.slice(unit.text_start, unit.text_end),
        ),
      ).toBe(true);
      expect(
        result.units.every((unit) => !/[\uD800-\uDFFF]/u.test(unit.text)),
      ).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        QUESTION_CONTEXT_BYTES,
      );
    });
    it('limits numerous matches and serialized escaping while retaining original segment identity', async () => {
      const { document, segments, request } = await source(1101, '');
      for (const segment of segments)
        segment.text = 'Ｂｕｄｇｅｔ checklist \\"😀'.repeat(100);
      await replace(document.id, segments);
      const result = await db.questions.evidence(actor.user_id, document.id, {
        ...request,
        transcript_revision: 2,
        question: 'Budget checklist?',
      });
      expect(result.mode).toBe('retrieved');
      expect(result.units.length).toBeGreaterThan(0);
      expect(result.units.length).toBeLessThan(25);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        QUESTION_CONTEXT_BYTES,
      );
      for (const unit of result.units) {
        const original = segments.find(
          (segment) => segment.id === unit.citation.id,
        )!;
        expect(unit.text).toBe(
          original.text.slice(unit.text_start, unit.text_end),
        );
        expect(unit.citation.revision).toBe(2);
      }
    });
    it('does not leak another current meeting owned by the same actor', async () => {
      const allowed = await source(1101, '');
      const unrelated = await source(
        1,
        'Budget checklist secret from another meeting.',
      );
      const result = await db.questions.evidence(
        actor.user_id,
        allowed.document.id,
        {
          ...allowed.request,
          question: 'Budget checklist secret?',
        },
      );
      expect(result.units).toEqual([]);
      expect(result.document_id).not.toBe(unrelated.document.id);
    });
    it('treats questions as bounded lexical data rather than SQL, URLs or embedded instructions', async () => {
      const { document, request } = await source(1101, '');
      const result = await db.questions.evidence(actor.user_id, document.id, {
        ...request,
        question:
          "'; DROP TABLE documents; -- https://attacker.invalid/collect",
      });
      expect(result.units).toEqual([]);
      expect((await db.document(actor.user_id, document.id)).id).toBe(
        document.id,
      );
      expect(await db.jobs(actor.user_id, document.id)).toEqual([]);
    });
    it('refuses stale revisions rather than silently asking about changed material', async () => {
      const { document, request } = await source();
      await db.edit(
        actor.user_id,
        document.id,
        1,
        { notes: 'New note' },
        randomUUID(),
      );
      await expect(
        db.questions.evidence(actor.user_id, document.id, request),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      await expect(
        db.questions.evidence(actor.user_id, document.id, {
          ...request,
          note_revision: 2,
          transcript_revision: 0,
        }),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
    });
    it('rejects cross-account, deleted and revoked resources before returning evidence', async () => {
      const { document, request } = await source(1101);
      const other = await db.provision(
        'urn:windows-ai-notes:development',
        randomUUID(),
      );
      await expect(
        db.questions.evidence(other.user_id, document.id, request),
      ).rejects.toMatchObject({ code: 'document_not_found' });
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1',
        [actor.user_id],
      );
      await expect(
        db.questions.evidence(actor.user_id, document.id, request),
      ).rejects.toMatchObject({ code: 'document_not_found' });
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE user_id=$1',
        [actor.user_id],
      );
      await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
        actor.user_id,
      ]);
      await expect(
        db.questions.evidence(actor.user_id, document.id, request),
      ).rejects.toMatchObject({ code: 'document_not_found' });
      await db.pool.query('UPDATE users SET active=true WHERE id=$1', [
        actor.user_id,
      ]);
      await db.pool.query('UPDATE documents SET deleted_at=now() WHERE id=$1', [
        document.id,
      ]);
      await expect(
        db.questions.evidence(actor.user_id, document.id, request),
      ).rejects.toMatchObject({ code: 'document_not_found' });
    });
    it('returns explicit empty evidence when the meeting or current-meeting retrieval has none', async () => {
      const empty = await source(0, '');
      expect(
        (
          await db.questions.evidence(
            actor.user_id,
            empty.document.id,
            empty.request,
          )
        ).units,
      ).toEqual([]);
      const large = await source(1101, '');
      expect(
        (
          await db.questions.evidence(actor.user_id, large.document.id, {
            ...large.request,
            question: 'Who is it?',
          })
        ).units,
      ).toEqual([]);
    });
    it('uses the newest bounded conversation terms for reference-only long-meeting retrieval', async () => {
      const { document, segments, request } = await source(1101, '');
      segments[1099]!.text = 'Checklist shipping is Friday.';
      await replace(document.id, segments);
      const result = await db.questions.evidence(
        actor.user_id,
        document.id,
        {
          ...request,
          transcript_revision: 2,
          question: 'When is it due?',
        },
        undefined,
        {
          version: 'meeting-question-context-v1',
          turns: [
            {
              question: 'Which phrase?',
              answer: Array.from(
                { length: 100 },
                (_, index) => `word${index}`,
              ).join(' '),
            },
            {
              question: 'Who owns the checklist?',
              answer: 'Mira owns the checklist.',
            },
          ],
        },
      );
      expect(result.mode).toBe('retrieved');
      expect(
        result.units.some((unit) => unit.citation.id === segments[1099]!.id),
      ).toBe(true);
      expect(result.units.every((unit) => unit.citation.revision === 2)).toBe(
        true,
      );
    });
    it('rechecks authorization after the initial frozen-source read', async () => {
      const { document, request } = await source(1101);
      const header = db.transcripts.header.bind(db.transcripts);
      vi.spyOn(db.transcripts, 'header').mockImplementationOnce(
        async (...args) => {
          const result = await header(...args);
          await db.pool.query(
            'UPDATE memberships SET active=false WHERE user_id=$1',
            [actor.user_id],
          );
          return result;
        },
      );
      await expect(
        db.questions.evidence(actor.user_id, document.id, request),
      ).rejects.toMatchObject({ code: 'document_not_found' });
    });
  },
);
