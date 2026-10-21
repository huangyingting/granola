import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Database, digest, recordChange } from '@windows-ai-notes/db';
import { type AiProviders } from '@windows-ai-notes/ai';
import { makeSilentWav } from '@windows-ai-notes/ai/wav';
import {
  documentSchema,
  jobSchema,
  ServiceError,
  type SummarySnapshot,
  type Summary,
  type JobResult,
  syncSnapshotSchema,
  syncChangesSchema,
} from '@windows-ai-notes/contracts/server';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import { runOnce } from '@windows-ai-notes/worker';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
function syntheticSummary(snapshot: SummarySnapshot): Summary {
  const citation = snapshot.notes.trim()
    ? {
        source: 'note' as const,
        id: snapshot.document_id,
        revision: snapshot.note_revision,
      }
    : {
        source: 'transcript' as const,
        id: snapshot.segments[0]!.id,
        revision: snapshot.transcript_revision,
      };
  return {
    overview: {
      text: snapshot.notes || snapshot.segments[0]!.text,
      citations: [citation],
    },
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
  };
}
const providers: AiProviders = {
  provider: 'fixture',
  configurationVersion: 'test-v1',
  summarize: async (snapshot) => ({
    summary: syntheticSummary(snapshot),
    usage: { input_tokens: 1, output_tokens: 1, audio_ms: 0 },
  }),
  transcribe: async () => ({
    segments: [
      { id: randomUUID(), start_ms: 0, end_ms: 500, text: 'Synthetic speech.' },
    ],
    usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
  }),
};

describe.skipIf(!databaseUrl)('PostgreSQL API and durable AI worker', () => {
  let admin: Database;
  let db: Database;
  let app: Awaited<ReturnType<typeof createServer>>;
  let scopedUrl: string;
  let base: string;
  const schema = `notes_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    admin = new Database(databaseUrl!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = scoped.href;
    db = new Database(scopedUrl);
    await db.migrate();
    await db.migrate();
    app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  });
  async function actor(workspaceId?: string) {
    const subject = randomUUID();
    const user = await db.provision(
      'urn:windows-ai-notes:development',
      subject,
      workspaceId,
    );
    return { ...user, headers: { 'x-dev-subject': subject } };
  }
  async function document(
    user: Awaited<ReturnType<typeof actor>>,
    notes = 'Original meeting notes.',
  ) {
    const result = await app.inject({
      method: 'POST',
      url: '/v1/documents',
      headers: { ...user.headers, 'idempotency-key': randomUUID() },
      payload: {
        workspace_id: user.workspace_id,
        title: 'Synthetic meeting',
        notes,
      },
    });
    expect(result.statusCode).toBe(201);
    return documentSchema.parse(result.json());
  }
  async function enqueue(
    user: Awaited<ReturnType<typeof actor>>,
    id: string,
    key = randomUUID(),
  ) {
    const result = await app.inject({
      method: 'POST',
      url: `/v1/documents/${id}/summary-runs`,
      headers: { ...user.headers, 'idempotency-key': key },
      payload: { note_revision: 1, transcript_revision: 0 },
    });
    expect(result.statusCode).toBe(202);
    return jobSchema.parse(result.json());
  }
  it('refuses startup without an applied migration, including an empty migration tracker', async () => {
    const emptySchema = `${schema}_unmigrated`;
    await admin.pool.query(`CREATE SCHEMA "${emptySchema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${emptySchema}`);
    const empty = new Database(url.href);
    try {
      await expect(empty.assertReady()).rejects.toThrow();
      await empty.pool.query(
        'CREATE TABLE schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
      );
      await expect(empty.assertReady()).rejects.toThrow(
        'Apply database migrations before starting the service.',
      );
      await empty.migrate();
      await expect(empty.assertReady()).resolves.toBeUndefined();
    } finally {
      await empty.close();
      await admin.pool.query(`DROP SCHEMA "${emptySchema}" CASCADE`);
    }
  });
  it('requires a provisioned identity and does not expose a bootstrap endpoint', async () => {
    const user = await actor();
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/bootstrap/admin',
      headers: user.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      code: 'route_not_found',
      request_id: expect.any(String),
    });
    expect((await app.inject('/v1/me')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v1/me',
          headers: { 'x-dev-subject': randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject('/health')).statusCode).toBe(200);
    const config = await app.inject('/v1/client-config');
    expect(config.statusCode).toBe(503);
    expect(config.json().code).toBe('desktop_login_not_configured');
  });
  it('verifies real signed OIDC tokens, issuer, audience, expiry and scope without accepting dev headers', async () => {
    const issuer = 'https://identity.example.test/';
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'synthetic-key',
      alg: 'RS256',
      use: 'sig',
    };
    await db.provision(issuer, 'synthetic-oidc-subject');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const secured = await createServer(db, {
      mode: 'oidc',
      host: '127.0.0.1',
      issuer,
      audience: 'notes-api',
      jwksUrl: 'https://identity.example.test/keys',
      requiredScope: 'notes.access',
    });
    const token = (
      audience = 'notes-api',
      scope = 'notes.access',
      exp = Math.floor(Date.now() / 1000) + 300,
      tokenIssuer = issuer,
    ) =>
      new SignJWT({ scope })
        .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
        .setIssuer(tokenIssuer)
        .setSubject('synthetic-oidc-subject')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(privateKey);
    try {
      expect(
        (
          await secured.inject({
            url: '/v1/me',
            headers: { authorization: `Bearer ${await token()}` },
          })
        ).statusCode,
      ).toBe(200);
      for (const invalid of [
        await token('wrong-audience'),
        await token('notes-api', 'other.scope'),
        await token(
          'notes-api',
          'notes.access',
          Math.floor(Date.now() / 1000) - 60,
        ),
        await token(
          'notes-api',
          'notes.access',
          Math.floor(Date.now() / 1000) + 300,
          'https://untrusted.example.test/',
        ),
        `${(await token()).split('.').slice(0, 2).join('.')}.aW52YWxpZA`,
      ]) {
        expect(
          (
            await secured.inject({
              url: '/v1/me',
              headers: { authorization: `Bearer ${invalid}` },
            })
          ).statusCode,
        ).toBe(401);
      }
      expect(
        (
          await secured.inject({
            url: '/v1/me',
            headers: { 'x-dev-subject': randomUUID() },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await secured.close();
      vi.unstubAllGlobals();
    }
  });
  it('isolates private documents across users even inside the same workspace', async () => {
    const owner = await actor();
    const other = await actor(owner.workspace_id);
    const doc = await document(owner);
    expect(
      (
        await app.inject({
          url: `/v1/documents/${doc.id}`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    const list = await app.inject({
      url: `/v1/documents?workspace_id=${owner.workspace_id}`,
      headers: other.headers,
    });
    expect(list.json<{ documents: unknown[] }>().documents).toEqual([]);
    const run = await app.inject({
      method: 'POST',
      url: `/v1/documents/${doc.id}/summary-runs`,
      headers: { ...other.headers, 'idempotency-key': randomUUID() },
      payload: { note_revision: 1, transcript_revision: 0 },
    });
    expect(run.statusCode).toBe(404);
  });
  it('enforces revision conflicts, immutable history, and idempotency payload binding', async () => {
    const owner = await actor();
    const key = randomUUID();
    const request = {
      method: 'POST' as const,
      url: '/v1/documents',
      headers: { ...owner.headers, 'idempotency-key': key },
      payload: {
        workspace_id: owner.workspace_id,
        title: 'Versioned',
        notes: 'Original',
      },
    };
    const first = await app.inject(request);
    const duplicate = await app.inject(request);
    expect(duplicate.json()).toEqual(first.json());
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...request.payload, title: 'Different' },
        })
      ).statusCode,
    ).toBe(409);
    const { id } = first.json<{ id: string }>();
    const edits = await Promise.all(
      ['A', 'B'].map((notes) =>
        app.inject({
          method: 'PUT',
          url: `/v1/documents/${id}/notes`,
          headers: owner.headers,
          payload: { base_revision: 1, notes },
        }),
      ),
    );
    expect(edits.map((edit) => edit.statusCode).sort()).toEqual([200, 409]);
    const history = await app.inject({
      url: `/v1/documents/${id}/notes?revision=1`,
      headers: owner.headers,
    });
    expect(history.json<{ notes: string }>().notes).toBe('Original');
  });
  it('persists jobs across database recreation, freezes input, and keeps summaries separate from notes', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    const recreated = new Database(scopedUrl);
    try {
      expect((await recreated.job(owner.user_id, job.id)).state).toBe('queued');
    } finally {
      await recreated.close();
    }
    await app.inject({
      method: 'PUT',
      url: `/v1/documents/${doc.id}/notes`,
      headers: owner.headers,
      payload: {
        base_revision: 1,
        notes: 'User edited while summary was queued.',
      },
    });
    await runOnce(db, providers);
    const completed = await db.job(owner.user_id, job.id);
    expect(completed.state).toBe('succeeded');
    expect(completed.input_stale).toBe(true);
    expect(completed.result?.kind).toBe('summary');
    if (completed.result?.kind === 'summary')
      expect(completed.result.summary.overview.text).toBe(
        'Original meeting notes.',
      );
    expect((await db.document(owner.user_id, doc.id)).notes).toBe(
      'User edited while summary was queued.',
    );
  });
  it('deduplicates task submissions and replays ordered SSE events only to authorized users', async () => {
    const owner = await actor();
    const other = await actor();
    const doc = await document(owner);
    const key = randomUUID();
    const job = await enqueue(owner, doc.id, key);
    expect((await enqueue(owner, doc.id, key)).id).toBe(job.id);
    await runOnce(db, providers);
    const replay = await app.inject({
      url: `/v1/jobs/${job.id}/events`,
      headers: { ...owner.headers, 'last-event-id': '1' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).not.toContain('id: 1\n');
    expect(replay.body).toContain('event: output.completed');
    expect(
      (
        await app.inject({
          url: `/v1/jobs/${job.id}/events`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/v1/jobs/${job.id}/events`,
          headers: { ...owner.headers, 'last-event-id': '1000' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('transcribes bounded audio without retaining bytes after completion', async () => {
    const owner = await actor();
    const doc = await document(owner, '');
    const uploaded = await app.inject({
      method: 'POST',
      url: `/v1/documents/${doc.id}/transcription-runs?base_revision=0&locale=en-US`,
      headers: {
        ...owner.headers,
        'content-type': 'audio/wav',
        'idempotency-key': randomUUID(),
      },
      payload: makeSilentWav(),
    });
    expect(uploaded.statusCode).toBe(202);
    const job = jobSchema.parse(uploaded.json());
    await runOnce(db, providers);
    const completed = await db.job(owner.user_id, job.id);
    expect(completed.state).toBe('succeeded');
    expect((await db.transcript(owner.user_id, doc.id)).segments).toHaveLength(
      1,
    );
    expect(
      (
        await db.pool.query<{ audio: Buffer | null }>(
          'SELECT audio FROM jobs WHERE id=$1',
          [job.id],
        )
      ).rows[0]!.audio,
    ).toBeNull();
  });
  it('does not overwrite manual transcript edits made during recognition', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await db.enqueueTranscription(
      owner.user_id,
      doc.id,
      0,
      'en-US',
      1000,
      makeSilentWav(),
      randomUUID(),
    );
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runOnce(db, {
      ...providers,
      transcribe: async (...args) => {
        start();
        await ready;
        return providers.transcribe(...args);
      },
    });
    await started;
    const manual = [
      { id: randomUUID(), start_ms: 0, end_ms: 100, text: 'Human correction' },
    ];
    await db.editTranscript(owner.user_id, doc.id, 0, manual);
    release();
    await running;
    expect((await db.job(owner.user_id, job.id)).error?.code).toBe(
      'revision_conflict',
    );
    expect((await db.transcript(owner.user_id, doc.id)).segments).toEqual(
      manual,
    );
  });
  it('fences expired workers and prevents duplicate result commits', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const queued = await enqueue(owner, doc.id);
    const old = (await db.claim(20))!;
    await delay(50);
    const replacement = (await db.claim())!;
    expect(replacement.id).toBe(queued.id);
    expect(replacement.leaseToken).toBeGreaterThan(old.leaseToken);
    if (old.input.kind !== 'summary') throw new Error('Expected summary');
    const result: JobResult = {
      kind: 'summary',
      summary: syntheticSummary(old.input.snapshot),
      provider: 'fixture',
      configuration_version: 'test-v1',
      prompt_version: 'meeting-summary-v1',
      usage: { input_tokens: 1, output_tokens: 1, audio_ms: 0 },
    };
    expect(await db.finish(old, result, null)).toBe(false);
    expect(await db.finish(replacement, result, null)).toBe(true);
    expect(await db.finish(replacement, result, null)).toBe(false);
  });
  it('cancels queued jobs, rejects expired replay cursors, and reports provider errors explicitly', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    await db.cancel(owner.user_id, job.id);
    expect((await db.cancel(owner.user_id, job.id)).already_terminal).toBe(
      true,
    );
    const second = await enqueue(owner, doc.id);
    await runOnce(db, {
      ...providers,
      summarize: async () => {
        throw new ServiceError(
          'provider_authentication_failed',
          'Configured credentials rejected.',
          502,
        );
      },
    });
    expect((await db.job(owner.user_id, second.id)).state).toBe('failed');
    await db.pool.query('DELETE FROM job_events WHERE job_id=$1', [second.id]);
    expect(
      (
        await app.inject({
          url: `/v1/jobs/${second.id}/events`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(410);
  });
  it('deletion fences in-flight output and removes note, audio and event bodies', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    const claimed = (await db.claim())!;
    await db.deleteDocument(owner.user_id, doc.id);
    expect(
      await db.finish(claimed, null, {
        code: 'late',
        message: 'late',
        retryable: false,
      }),
    ).toBe(false);
    expect(
      (await app.inject({ url: `/v1/jobs/${job.id}`, headers: owner.headers }))
        .statusCode,
    ).toBe(404);
    const stored = (
      await db.pool.query<{ input: unknown; result: unknown; audio: unknown }>(
        'SELECT input,result,audio FROM jobs WHERE id=$1',
        [job.id],
      )
    ).rows[0]!;
    expect(stored).toEqual({ input: {}, result: null, audio: null });
    expect(
      (
        await db.pool.query(
          'SELECT 1 FROM note_versions WHERE document_id=$1',
          [doc.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query('SELECT 1 FROM job_events WHERE job_id=$1', [
          job.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('terminates live SSE when workspace membership is revoked', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/jobs/${job.id}/events`, {
      headers: owner.headers,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        'job.accepted',
      );
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
        [owner.workspace_id, owner.user_id],
      );
      expect((await reader.read()).done).toBe(true);
      expect(
        (
          await app.inject({
            url: `/v1/jobs/${job.id}`,
            headers: owner.headers,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });
  it('drains live SSE subscriptions when the API shuts down', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    const closing = await createServer(db, {
      mode: 'development',
      host: '127.0.0.1',
    });
    const address = await closing.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/v1/jobs/${job.id}/events`, {
      headers: owner.headers,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        'job.accepted',
      );
      const stopped = closing.close();
      expect((await reader.read()).done).toBe(true);
      await stopped;
    } finally {
      controller.abort();
      reader.releaseLock();
      await closing.close();
      await db.cancel(owner.user_id, job.id);
    }
  });
  it('rejects invalid audio and enforces queue limits without provider calls', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/documents/${doc.id}/transcription-runs?base_revision=0`,
      headers: {
        ...owner.headers,
        'content-type': 'audio/wav',
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.from('invalid'),
    });
    expect(invalid.statusCode).toBe(400);
    for (let i = 0; i < 8; i++) await enqueue(owner, doc.id);
    const ninth = await app.inject({
      method: 'POST',
      url: `/v1/documents/${doc.id}/summary-runs`,
      headers: { ...owner.headers, 'idempotency-key': randomUUID() },
      payload: { note_revision: 1, transcript_revision: 0 },
    });
    expect(ninth.statusCode).toBe(429);
    await db.deleteDocument(owner.user_id, doc.id);
  });
  it('retries a transient provider error and preserves staged audio only until success', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const key = randomUUID();
    const wav = makeSilentWav();
    const job = await db.enqueueTranscription(
      owner.user_id,
      doc.id,
      0,
      'en-US',
      1000,
      wav,
      key,
    );
    await runOnce(db, {
      ...providers,
      transcribe: async () => {
        throw new ServiceError(
          'provider_rate_limited',
          'Synthetic quota response.',
          503,
          true,
        );
      },
    });
    expect((await db.job(owner.user_id, job.id)).state).toBe('retry_wait');
    expect(
      (
        await db.pool.query<{ audio: unknown }>(
          'SELECT audio FROM jobs WHERE id=$1',
          [job.id],
        )
      ).rows[0]!.audio,
    ).not.toBeNull();
    await db.pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [
      job.id,
    ]);
    await runOnce(db, providers);
    expect((await db.job(owner.user_id, job.id)).attempt).toBe(2);
    expect(
      (
        await db.enqueueTranscription(
          owner.user_id,
          doc.id,
          0,
          'en-US',
          1000,
          wav,
          key,
        )
      ).id,
    ).toBe(job.id);
  });
  it('refuses in-flight commits after membership revocation and remains readable after explicit reactivation', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    const claimed = (await db.claim())!;
    await db.pool.query(
      'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
      [owner.workspace_id, owner.user_id],
    );
    expect(
      await db.finish(claimed, null, {
        code: 'late',
        message: 'late',
        retryable: false,
      }),
    ).toBe(false);
    await db.pool.query(
      'UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',
      [owner.workspace_id, owner.user_id],
    );
    expect((await db.job(owner.user_id, job.id)).state).toBe('cancelled');
  });
  it('expires staged audio and bounds abandoned-worker recovery attempts', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const audio = await db.enqueueTranscription(
      owner.user_id,
      doc.id,
      0,
      'en-US',
      1000,
      makeSilentWav(),
      randomUUID(),
    );
    await db.pool.query(
      "UPDATE jobs SET created_at=now()-interval '25 hours' WHERE id=$1",
      [audio.id],
    );
    await db.cleanup();
    expect((await db.job(owner.user_id, audio.id)).error?.code).toBe(
      'audio_expired',
    );
    const job = await enqueue(owner, doc.id);
    for (let i = 0; i < 3; i++) {
      expect((await db.claim())!.id).toBe(job.id);
      await db.pool.query(
        "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [job.id],
      );
    }
    expect(await db.claim()).toBeNull();
    expect((await db.job(owner.user_id, job.id)).error?.code).toBe(
      'attempts_exhausted',
    );
  });
  it('upgrades existing v1 data and preserves legacy creation idempotency', async () => {
    const legacySchema = `${schema}_legacy`;
    await admin.pool.query(`CREATE SCHEMA "${legacySchema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${legacySchema}`);
    const legacy = new Database(url.href);
    try {
      const sql = await readFile(
        new URL(
          '../../../packages/db/migrations/001_initial.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await legacy.pool.query(
        'CREATE TABLE schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
      );
      await legacy.pool.query(sql);
      await legacy.pool.query('INSERT INTO schema_migrations VALUES (1,$1)', [
        createHash('sha256').update(sql).digest('hex'),
      ]);
      const user = await legacy.provision(
        'urn:windows-ai-notes:development',
        randomUUID(),
      );
      const id = randomUUID();
      const input = {
        workspace_id: user.workspace_id,
        title: 'Legacy',
        notes: 'Unchanged\r\nnotes.',
      };
      const key = randomUUID();
      await legacy.pool.query(
        'INSERT INTO documents (id,workspace_id,owner_id,title,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, user.workspace_id, user.user_id, input.title, key, digest(input)],
      );
      await legacy.pool.query(
        'INSERT INTO note_versions (document_id,revision,notes) VALUES ($1,1,$2)',
        [id, input.notes],
      );
      const evidence = [
        {
          id: randomUUID().toUpperCase(),
          start_ms: 1,
          end_ms: 1000,
          text: 'Legacy 中文 🎙️ evidence.',
        },
        {
          id: randomUUID(),
          start_ms: 1001,
          end_ms: 2000,
          text: 'Preserved second segment.',
        },
      ];
      await legacy.pool.query(
        "INSERT INTO transcript_revisions (document_id,revision,source,segments) VALUES ($1,1,'manual',$2)",
        [id, JSON.stringify(evidence)],
      );
      await legacy.pool.query(
        'UPDATE documents SET transcript_revision=1 WHERE id=$1',
        [id],
      );
      await legacy.migrate();
      await legacy.assertReady();
      expect(
        await legacy.createDocument(user.user_id, input, key),
      ).toMatchObject({ id, notes: input.notes, content: null, tags: [] });
      expect(await legacy.transcript(user.user_id, id)).toMatchObject({
        revision: 1,
        source: 'manual',
        segments: evidence,
      });
      expect(await legacy.transcripts.page(user.user_id, id, 1)).toMatchObject({
        total_segments: 2,
        offset: 0,
        segments: evidence,
        has_more: false,
      });
      expect(
        (await legacy.transcripts.header(user.user_id, id, 1)).text_bytes,
      ).toBe(
        evidence.reduce(
          (sum, segment) => sum + Buffer.byteLength(segment.text),
          0,
        ),
      );
      await legacy.pool.query(
        "UPDATE schema_migrations SET checksum='modified' WHERE version=1",
      );
      await expect(legacy.migrate()).rejects.toThrow(
        'Applied migration checksum mismatch.',
      );
    } finally {
      await legacy.close();
      await admin.pool.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });
  it('supports offline document IDs, rich notes, tags and content-safe exports', async () => {
    const owner = await actor();
    const id = randomUUID();
    const content = richTextFromPlainText('Notes with 中文 and <tags>.');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/documents',
      headers: { ...owner.headers, 'idempotency-key': randomUUID() },
      payload: {
        id,
        workspace_id: owner.workspace_id,
        title: 'Offline draft',
        content,
        tags: ['Planning'],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(documentSchema.parse(response.json())).toMatchObject({
      id,
      content,
      notes: 'Notes with 中文 and <tags>.',
      tags: ['Planning'],
    });
    const other = await actor(owner.workspace_id);
    const collision = await app.inject({
      method: 'POST',
      url: '/v1/documents',
      headers: { ...other.headers, 'idempotency-key': randomUUID() },
      payload: { id, workspace_id: owner.workspace_id, title: 'Collision' },
    });
    expect(collision.statusCode).toBe(409);
    const markdown = await app.inject({
      url: `/v1/documents/${id}/export`,
      headers: owner.headers,
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers['content-disposition']).toContain('.md');
    expect(markdown.body).toContain('Notes with 中文 and &lt;tags&gt;\\.');
    expect(
      (
        await app.inject({
          url: `/v1/documents/${id}/export`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    const invalid = await app.inject({
      method: 'PUT',
      url: `/v1/documents/${id}/notes`,
      headers: owner.headers,
      payload: { base_revision: 1, content, notes: 'Different evidence' },
    });
    expect(invalid.statusCode).toBe(400);
  });
  it('replays idempotent note mutations without overwriting intervening edits', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const key = randomUUID();
    const payload = {
      base_revision: 1,
      content: richTextFromPlainText('Saved once.'),
    };
    const request = {
      method: 'PUT' as const,
      url: `/v1/documents/${doc.id}/notes`,
      headers: { ...owner.headers, 'idempotency-key': key },
      payload,
    };
    expect(
      documentSchema.parse((await app.inject(request)).json()),
    ).toMatchObject({ revision: 2, applied_revision: 2 });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/documents/${doc.id}`,
          headers: request.headers,
          payload: {
            base_revision: 2,
            title: 'Metadata uses its own route scope',
            tags: ['Edited'],
          },
        })
      ).statusCode,
    ).toBe(200);
    await db.edit(owner.user_id, doc.id, 3, { notes: 'Newer edit.' });
    const replayed = documentSchema.parse((await app.inject(request)).json());
    expect(replayed).toMatchObject({
      revision: 4,
      applied_revision: 2,
      notes: 'Newer edit.',
      tags: ['Edited'],
    });
    expect(
      (
        await app.inject({
          ...request,
          payload: { base_revision: 1, notes: 'Changed input' },
        })
      ).statusCode,
    ).toBe(409);
    const stale = await app.inject({
      ...request,
      headers: { ...owner.headers, 'idempotency-key': randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current_revision).toBe(4);
    await db.deleteDocument(owner.user_id, doc.id);
    expect((await app.inject(request)).statusCode).toBe(404);
  });
  it('keeps a stable bootstrap watermark across snapshot pages and subsequent mutations', async () => {
    const owner = await actor();
    const ids = [1, 2, 4].map(
      (last) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`,
    );
    const create = async (id: string) => {
      const result = await app.inject({
        method: 'POST',
        url: '/v1/documents',
        headers: { ...owner.headers, 'idempotency-key': randomUUID() },
        payload: { id, workspace_id: owner.workspace_id, title: id },
      });
      expect(result.statusCode).toBe(201);
    };
    await create(ids[1]!);
    await create(ids[2]!);
    const first = syncSnapshotSchema.parse(
      (
        await app.inject({
          url: `/v1/sync/snapshot?workspace_id=${owner.workspace_id}&limit=1`,
          headers: owner.headers,
        })
      ).json(),
    );
    expect(first.documents.map((item) => item.id)).toEqual([ids[1]]);
    await create(ids[0]!);
    await db.edit(owner.user_id, ids[2]!, 1, {
      title: 'Changed during snapshot',
    });
    await db.deleteDocument(owner.user_id, ids[1]!);
    const second = syncSnapshotSchema.parse(
      (
        await app.inject({
          url: `/v1/sync/snapshot?workspace_id=${owner.workspace_id}&limit=1&after=${first.next_after}&cursor=${first.cursor}`,
          headers: owner.headers,
        })
      ).json(),
    );
    expect(second.cursor).toBe(first.cursor);
    expect(second.documents.map((item) => item.id)).toEqual([ids[2]]);
    expect(second.has_more).toBe(false);
    let cursor = first.cursor;
    const changes = [];
    for (let page = 0; page < 3; page++) {
      const result = syncChangesSchema.parse(
        (
          await app.inject({
            url: `/v1/sync/changes?workspace_id=${owner.workspace_id}&cursor=${cursor}&limit=1`,
            headers: owner.headers,
          })
        ).json(),
      );
      changes.push(...result.changes);
      cursor = result.cursor;
      expect(result.has_more).toBe(page < 2);
    }
    expect(changes.map((change) => [change.document_id, change.kind])).toEqual([
      [ids[0], 'document'],
      [ids[2], 'document'],
      [ids[1], 'deleted'],
    ]);
  });
  it('scopes sync to owners, invalidates revoked membership cursors and reports retention expiry', async () => {
    const owner = await actor();
    const colleague = await actor(owner.workspace_id);
    const first = await db.sync.snapshot(owner.user_id, owner.workspace_id);
    const privateDoc = await document(
      colleague,
      'Must never appear in another owner sync.',
    );
    const own = await document(owner);
    const changed = await db.sync.changes(
      owner.user_id,
      owner.workspace_id,
      first.cursor,
    );
    expect(changed.changes.map((item) => item.document_id)).toEqual([own.id]);
    expect(JSON.stringify(changed)).not.toContain(privateDoc.id);
    await expect(
      db.sync.changes(colleague.user_id, owner.workspace_id, first.cursor),
    ).rejects.toMatchObject({ code: 'invalid_sync_cursor' });
    await db.pool.query(
      'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
      [owner.workspace_id, owner.user_id],
    );
    await expect(
      db.sync.changes(owner.user_id, owner.workspace_id, changed.cursor),
    ).rejects.toMatchObject({
      code: 'workspace_access_revoked',
      details: { purge_workspace_id: owner.workspace_id },
    });
    await db.pool.query(
      'UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',
      [owner.workspace_id, owner.user_id],
    );
    await expect(
      db.sync.changes(owner.user_id, owner.workspace_id, changed.cursor),
    ).rejects.toMatchObject({ code: 'sync_cursor_expired' });
    const reset = await db.sync.snapshot(owner.user_id, owner.workspace_id);
    await db.edit(owner.user_id, own.id, 1, { notes: 'A later edit' });
    await db.pool.query(
      "UPDATE sync_changes SET created_at=now()-interval '8 days' WHERE workspace_id=$1",
      [owner.workspace_id],
    );
    await db.cleanup();
    await expect(
      db.sync.changes(owner.user_id, owner.workspace_id, reset.cursor),
    ).rejects.toMatchObject({ code: 'sync_cursor_expired' });
    expect(
      (await db.sync.snapshot(owner.user_id, owner.workspace_id)).documents,
    ).toHaveLength(1);
  });
  it('does not advance sync beyond a transaction that has not committed', async () => {
    const owner = await actor();
    const a = await document(owner);
    const b = await document(owner);
    const snapshot = await db.sync.snapshot(owner.user_id, owner.workspace_id);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = db.transaction(async (tx) => {
      await recordChange(tx, a.id, 'document');
      entered();
      await held;
    });
    await ready;
    const second = db.edit(owner.user_id, b.id, 1, { title: 'Second writer' });
    try {
      expect(
        (
          await db.sync.changes(
            owner.user_id,
            owner.workspace_id,
            snapshot.cursor,
          )
        ).changes,
      ).toHaveLength(0);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(
      (
        await db.sync.changes(
          owner.user_id,
          owner.workspace_id,
          snapshot.cursor,
        )
      ).changes.map((change) => change.document_id),
    ).toEqual([a.id, b.id]);
  });
  it('returns a revision conflict after waiting for another committed document version', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const name = `revision_lock_${randomUUID()}`;
    const url = new URL(scopedUrl);
    url.searchParams.set('application_name', name);
    const competing = new Database(url.href);
    const server = await createServer(competing, {
      mode: 'development',
      host: '127.0.0.1',
    });
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [
        doc.id,
      ]);
      await lock.query('UPDATE documents SET revision=2 WHERE id=$1', [doc.id]);
      await lock.query(
        'INSERT INTO note_versions (document_id,revision,notes) VALUES ($1,2,$2)',
        [doc.id, 'Committed first.'],
      );
      await recordChange(lock, doc.id, 'document');
      const response = server
        .inject({
          method: 'PUT',
          url: `/v1/documents/${doc.id}/notes`,
          headers: owner.headers,
          payload: { base_revision: 1, notes: 'Stale competing save.' },
        })
        .then((result) => result);
      await vi.waitFor(
        async () => {
          const activity = await db.pool.query<{
            wait_event_type: string | null;
          }>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1',
            [name],
          );
          expect(
            activity.rows.some((row) => row.wait_event_type === 'Lock'),
          ).toBe(true);
        },
        { timeout: 2000, interval: 10 },
      );
      await lock.query('COMMIT');
      const result = await response;
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        code: 'revision_conflict',
        current_revision: 2,
      });
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await server.close();
      await competing.close();
    }
  });
  it('rechecks membership after waiting for a document lock during worker completion', async () => {
    const owner = await actor();
    const doc = await document(owner);
    const job = await enqueue(owner, doc.id);
    const claimed = (await db.claim())!;
    const name = `completion_lock_${randomUUID()}`;
    const url = new URL(scopedUrl);
    url.searchParams.set('application_name', name);
    const competing = new Database(url.href);
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [
        doc.id,
      ]);
      const completed = competing.finish(claimed, null, {
        code: 'late',
        message: 'Late failure.',
        retryable: false,
      });
      await vi.waitFor(
        async () => {
          const activity = await db.pool.query<{
            wait_event_type: string | null;
          }>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1',
            [name],
          );
          expect(
            activity.rows.some((row) => row.wait_event_type === 'Lock'),
          ).toBe(true);
        },
        { timeout: 2000, interval: 10 },
      );
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',
        [owner.workspace_id, owner.user_id],
      );
      await lock.query('COMMIT');
      expect(await completed).toBe(false);
      await db.pool.query(
        'UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',
        [owner.workspace_id, owner.user_id],
      );
      expect((await db.job(owner.user_id, job.id)).state).toBe('cancelled');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await competing.close();
    }
  });
  it('makes durable job history and lifecycle changes discoverable without exposing inputs', async () => {
    const owner = await actor();
    const other = await actor(owner.workspace_id);
    const doc = await document(owner);
    const snapshot = await db.sync.snapshot(owner.user_id, owner.workspace_id);
    const job = await enqueue(owner, doc.id);
    await runOnce(db, providers);
    const response = await app.inject({
      url: `/v1/documents/${doc.id}/jobs`,
      headers: owner.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().jobs[0]).toMatchObject({
      id: job.id,
      state: 'succeeded',
    });
    expect(response.json().jobs[0]).not.toHaveProperty('input');
    expect(response.json().jobs[0]).not.toHaveProperty('audio');
    expect(
      (
        await app.inject({
          url: `/v1/documents/${doc.id}/jobs`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    const changes = await db.sync.changes(
      owner.user_id,
      owner.workspace_id,
      snapshot.cursor,
    );
    expect(
      changes.changes.every(
        (change) => change.kind === 'job' && change.job_id === job.id,
      ),
    ).toBe(true);
    expect(changes.changes).toHaveLength(4);
  });
});
