import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database, withAuditContext } from '@windows-ai-notes/db';
import { createAzureProviders } from '@windows-ai-notes/ai';
import { registerProviderTelemetry } from '@windows-ai-notes/ai/observability';
import {
  providerEventSchema,
  type ProviderEvent,
} from '@windows-ai-notes/contracts/observability';
import { runOnce } from '@windows-ai-notes/worker';
import { chatTurnSchema } from '@windows-ai-notes/contracts/questions';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = 'private-provider-meeting-configuration';
const config = {
  AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/',
  AZURE_OPENAI_API_KEY: secret,
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
  AZURE_OPENAI_DEPLOYMENT: secret,
  AZURE_SPEECH_KEY: secret,
  AZURE_SPEECH_REGION: 'westus',
};
describe.skipIf(!databaseUrl)('reserved Azure call correlation', () => {
  const schema = `provider_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Database, db: Database;
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeAll(async () => {
    admin = new Database(databaseUrl!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = new Database(url.href);
    await db.migrate();
    app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE users,workspaces,audit_events CASCADE');
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  });
  async function actor() {
    const subject = randomUUID();
    const owner = await db.provision(
      'urn:windows-ai-notes:development',
      subject,
    );
    const headers = { 'x-dev-subject': subject, 'x-request-id': secret };
    const doc = await db.createDocument(
      owner.user_id,
      {
        workspace_id: owner.workspace_id,
        title: secret,
        notes: secret,
      },
      randomUUID(),
    );
    return { owner, headers, document: doc.id };
  }
  async function queue() {
    const { owner, headers, document } = await actor();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/documents/${document}/summary-runs`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { note_revision: 1, transcript_revision: 0 },
    });
    expect(response.statusCode).toBe(202);
    return {
      owner,
      headers,
      document,
      job: String(response.json().id),
      request: String(response.headers['x-request-id']),
    };
  }
  function summary(document: string) {
    return {
      overview: {
        text: secret,
        citations: [{ source: 'note', id: document, revision: 1 }],
      },
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
    };
  }
  function frames(value: unknown) {
    return [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { content: JSON.stringify(value) },
            finish_reason: 'stop',
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`,
    ];
  }
  function collect() {
    const rows: ProviderEvent[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        rows.push(providerEventSchema.parse(JSON.parse(String(chunk))));
        done();
      },
    });
    return { rows, close: registerProviderTelemetry(output) };
  }

  it('links concurrent authenticated acceptance, reserved usage and actual Azure requests without depending on audit retention', async () => {
    const jobs = await Promise.all([queue(), queue()]);
    await db.pool.query('TRUNCATE audit_events');
    const sent: string[] = [];
    const providers = createAzureProviders(config, async (_url, init) => {
      sent.push(new Headers(init?.headers).get('x-ms-client-request-id')!);
      const doc = jobs.find((job) =>
        String(init?.body).includes(job.document),
      )?.document;
      if (!doc)
        throw new Error('The request has no expected synthetic evidence.');
      return new Response(frames(summary(doc)).join('') + 'data: [DONE]\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          'apim-request-id': secret,
        },
      });
    });
    const captured = collect();
    try {
      expect(
        await Promise.all([runOnce(db, providers), runOnce(db, providers)]),
      ).toEqual([true, true]);
      expect(captured.rows).toHaveLength(4);
      expect(new Set(sent).size).toBe(2);
      for (const job of jobs) {
        const events = captured.rows.filter(
          (event) => event.job_id === job.job,
        );
        expect(events).toHaveLength(2);
        const usage = await db.pool.query<{ id: string }>(
          'SELECT id FROM ai_usage_calls WHERE job_id=$1',
          [job.job],
        );
        for (const event of events) {
          expect(event).toMatchObject({
            source: 'worker',
            origin_request_id: job.request,
            usage_call_id: usage.rows[0]!.id,
            job_id: job.job,
            turn_id: null,
          });
          expect(sent).toContain(event.client_request_id);
        }
        expect(events[1]).toMatchObject({
          outcome: 'returned',
          operation: 'summarize',
          first_content_ms: expect.any(Number),
          provider_response_id: null,
          provider_response_id_status: 'rejected',
        });
        expect((await db.job(job.owner.user_id, job.job)).state).toBe(
          'succeeded',
        );
      }
      expect(JSON.stringify(captured.rows)).not.toContain(secret);
      for (const job of jobs)
        expect(JSON.stringify(captured.rows)).not.toContain(job.owner.user_id);
    } finally {
      captured.close();
    }
  });

  it('carries authenticated chat-turn origins through the same real Azure and usage boundary', async () => {
    const user = await actor();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/documents/${user.document}/chat-turns`,
      headers: { ...user.headers, 'idempotency-key': randomUUID() },
      payload: {
        note_revision: 1,
        transcript_revision: 0,
        language: 'en',
        question: secret,
        confirmed: true,
      },
    });
    expect(response.statusCode).toBe(202);
    const turn = chatTurnSchema.parse(response.json());
    const providers = createAzureProviders(
      config,
      async () =>
        new Response(
          frames({
            answer: {
              text: secret,
              citations: [{ source: 'note', id: user.document, revision: 1 }],
            },
            status: 'answered',
          }).join('') + 'data: [DONE]\n\n',
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    );
    const captured = collect();
    try {
      expect(await runOnce(db, providers)).toBe(true);
      expect((await db.chat.get(user.owner.user_id, turn.id)).state).toBe(
        'succeeded',
      );
      expect(captured.rows).toHaveLength(2);
      for (const row of captured.rows)
        expect(row).toMatchObject({
          source: 'worker',
          operation: 'answer',
          turn_id: turn.id,
          job_id: null,
          origin_request_id: response.headers['x-request-id'],
          usage_call_id: expect.any(String),
        });
      expect(JSON.stringify(captured.rows)).not.toContain(secret);
    } finally {
      captured.close();
    }
  });

  it('keeps known usage and correlation after document deletion without confusing provider return with job success', async () => {
    const job = await queue();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let recorded!: () => void;
    const receipt = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    const providers = createAzureProviders(config, async () => {
      let part = 0;
      const chunks = frames(summary(job.document));
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (part < chunks.length) {
                controller.enqueue(new TextEncoder().encode(chunks[part++]!));
              } else if (part === chunks.length) {
                part++;
                recorded();
                await gate;
                controller.enqueue(
                  new TextEncoder().encode('data: [DONE]\n\n'),
                );
              } else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    });
    const captured = collect();
    const running = runOnce(db, providers);
    try {
      await receipt;
      expect(
        (await db.usage.snapshot(job.owner.user_id)).settled_requests,
      ).toBe('1');
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/documents/${job.document}`,
            headers: job.headers,
          })
        ).statusCode,
      ).toBe(204);
      resume();
      await running;
      expect(
        (await db.pool.query('SELECT state FROM jobs WHERE id=$1', [job.job]))
          .rows[0].state,
      ).toBe('cancelled');
      const completed = captured.rows.find(
        (event) => event.code === 'provider_call_completed',
      );
      expect(completed).toMatchObject({
        origin_request_id: job.request,
        job_id: job.job,
        source: 'worker',
        dispatched: true,
      });
      expect(
        completed?.code === 'provider_call_completed' &&
          ['returned', 'cancelled'].includes(completed.outcome),
      ).toBe(true);
      expect(
        (await db.usage.snapshot(job.owner.user_id)).settled_requests,
      ).toBe('1');
      await expect(
        db.document(job.owner.user_id, job.document),
      ).rejects.toThrow();
      expect(JSON.stringify(captured.rows)).not.toContain(secret);
    } finally {
      resume();
      await running;
      captured.close();
    }
  });

  it('does not invent a historical origin while upgrading and does not leak an earlier transaction context into later inserts', async () => {
    const before = await queue();
    await db.pool.query(`ALTER TABLE jobs DROP COLUMN origin_request_id;
      ALTER TABLE chat_turns DROP COLUMN origin_request_id;
      ALTER TABLE live_leases DROP COLUMN origin_request_id`);
    const migration = await readFile(
      new URL(
        '../../../packages/db/migrations/012_provider_origin.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await withAuditContext(
      { source: 'deployment', request_id: randomUUID() },
      () => db.transaction((tx) => tx.query(migration)),
    );
    expect(
      (
        await db.pool.query('SELECT origin_request_id FROM jobs WHERE id=$1', [
          before.job,
        ])
      ).rows[0].origin_request_id,
    ).toBeNull();
    const next = await queue();
    expect(
      (
        await db.pool.query('SELECT origin_request_id FROM jobs WHERE id=$1', [
          next.job,
        ])
      ).rows[0].origin_request_id,
    ).toBe(next.request);
    await expect(db.usage.correlation(randomUUID())).rejects.toThrow(
      'reserved provider call is missing',
    );
  });
});
