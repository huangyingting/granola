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
  type AiProviders,
  factsSummaryPromptVersion,
} from '@windows-ai-notes/ai';
import {
  LONG_SUMMARY_VERSION,
  ServiceError,
  jobSchema,
  type Segment,
  type Summary,
} from '@windows-ai-notes/contracts/server';
import {
  type EvidenceFacts,
  type SummaryEvidenceChunk,
  type SummaryFactsInput,
} from '@windows-ai-notes/contracts/evidence';
import { runOnce } from '@windows-ai-notes/worker';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const actual = { input_tokens: 3, output_tokens: 2, audio_ms: 0 };
const fixture: AiProviders = {
  provider: 'fixture',
  configurationVersion: 'long-summary-fixture-v1',
  transcribe: async () => {
    throw new Error('Unexpected audio dispatch.');
  },
  summarize: async () => {
    throw new Error('Unexpected direct summary dispatch.');
  },
  extract: async (chunk) => {
    const unit =
      chunk.units.find(
        (unit) => !unit.overlap && unit.citation.source === 'transcript',
      ) ?? chunk.units.find((unit) => !unit.overlap)!;
    return {
      facts: [
        {
          category: 'decision',
          text: unit.text.slice(0, 80),
          citations: [unit.citation],
          owner: null,
          due_date: null,
        },
      ],
      usage: actual,
    };
  },
  merge: async (input) => ({ facts: input.facts.slice(0, 16), usage: actual }),
  summarizeFacts: async (input) => {
    const citation =
      input.facts
        .flatMap((fact) => fact.citations)
        .find((citation) => citation.source === 'transcript') ??
      input.facts[0]!.citations[0]!;
    return {
      summary: {
        overview: {
          text: 'Synthetic long-meeting cited result.',
          citations: [citation],
        },
        topics: [],
        decisions: [],
        action_items: [],
        open_questions: [],
      },
      usage: actual,
    };
  },
};
describe.skipIf(!databaseUrl)(
  'authorized resumable full-meeting generation',
  { timeout: 30_000 },
  () => {
    const schema = `notes_long_${randomUUID().replaceAll('-', '')}`;
    let admin: Database, db: Database, scopedUrl: string;
    let app: Awaited<ReturnType<typeof createServer>>;
    let actor: { user_id: string; workspace_id: string },
      headers: { 'x-dev-subject': string };
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      scopedUrl = url.href;
      db = new Database(scopedUrl);
      await db.migrate();
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
    });
    beforeEach(async () => {
      await db.pool.query('TRUNCATE users,workspaces CASCADE');
      const subject = randomUUID();
      actor = await db.provision('urn:windows-ai-notes:development', subject);
      headers = { 'x-dev-subject': subject };
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.close();
      }
    });
    async function source(count = 1101, notes = 'Frozen human note evidence.') {
      const document = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic long meeting',
          notes,
        },
        randomUUID(),
      );
      const segments: Segment[] = Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        start_ms: index * 1000,
        end_ms: index * 1000 + 800,
        text: `Synthetic original segment ${index}. Confirm its evidence.${count <= 1000 ? ' Synthetic detailed evidence.'.repeat(20) : ''}`,
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
      return { document, segments };
    }
    async function enqueue(
      document: { id: string },
      allow = true,
      revision = 1,
    ) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/documents/${document.id}/summary-runs`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: {
          note_revision: 1,
          transcript_revision: revision,
          language: 'en',
          ...(allow ? { allow_long_context: true } : {}),
        },
      });
      return response;
    }
    async function queued(count = 1101, notes?: string) {
      const data = await source(count, notes);
      const response = await enqueue(data.document, true, count ? 1 : 0);
      expect(response.statusCode).toBe(202);
      return { ...data, job: jobSchema.parse(response.json()) };
    }
    async function resume(id: string) {
      const progress = await db.summaries.progress(actor.user_id, id);
      expect(progress.resume_available).toBe(true);
      await db.summaries.resume(actor.user_id, id, progress.resume_token!);
    }
    const cited = (value: Summary) => value.overview.citations[0]!;
    it('negotiates a separate capability and keeps legacy requests bounded without materializing the long transcript', async () => {
      const data = await source();
      const capability = await app.inject({
        method: 'GET',
        url: '/v1/summary-capabilities',
        headers,
      });
      expect(capability.json()).toEqual({
        long_meetings: LONG_SUMMARY_VERSION,
      });
      expect(
        (await app.inject({ method: 'GET', url: '/v1/summary-capabilities' }))
          .statusCode,
      ).toBe(401);
      const old = await enqueue(data.document, false);
      expect(old.statusCode).toBe(413);
      expect(await db.jobs(actor.user_id, data.document.id)).toHaveLength(0);
      const legacy = vi.spyOn(db.transcripts, 'legacy');
      const response = await enqueue(data.document);
      expect(response.statusCode).toBe(202);
      expect(legacy).not.toHaveBeenCalled();
      const claim = (await db.claim())!;
      expect(claim.input).toMatchObject({
        kind: 'summary',
        snapshot: { segments: [] },
        source: {
          version: LONG_SUMMARY_VERSION,
          transcript: { total_segments: 1101 },
        },
      });
      expect(Buffer.byteLength(JSON.stringify(claim.input))).toBeLessThan(4096);
    });
    it('processes every original source range, merges bounded facts, sums saved usage and inspects only cited frozen segments', async () => {
      const { document, segments, job } = await queued();
      const chunks: SummaryEvidenceChunk[] = [],
        merges: SummaryFactsInput[] = [];
      const extract = fixture.extract!,
        merge = fixture.merge!;
      await runOnce(db, {
        ...fixture,
        extract: async (chunk, signal, report) => {
          chunks.push(structuredClone(chunk));
          return extract(chunk, signal, report);
        },
        merge: async (input, signal, report) => {
          merges.push(structuredClone(input));
          return merge(input, signal, report);
        },
      });
      const completed = await db.job(actor.user_id, job.id);
      expect(completed.state).toBe('succeeded');
      expect(completed.result?.kind).toBe('summary');
      if (completed.result?.kind !== 'summary')
        throw new Error('Expected summary result.');
      expect(completed.result.prompt_version).toBe(
        factsSummaryPromptVersion({}),
      );
      expect(chunks.length).toBeGreaterThan(1);
      expect(merges.length).toBeGreaterThan(0);
      for (const segment of segments) {
        const pieces = chunks
          .flatMap((chunk) => chunk.units)
          .filter((unit) => !unit.overlap && unit.citation.id === segment.id);
        expect(pieces.map((unit) => unit.text).join('')).toBe(segment.text);
        expect(
          pieces.every(
            (unit) =>
              unit.start_ms === segment.start_ms &&
              unit.end_ms === segment.end_ms,
          ),
        ).toBe(true);
      }
      expect(
        chunks
          .flatMap((chunk) => chunk.units)
          .filter((unit) => !unit.overlap && unit.citation.source === 'note')
          .map((unit) => unit.text)
          .join(''),
      ).toBe(document.notes);
      const progress = await db.summaries.progress(actor.user_id, job.id);
      expect(progress.completed_stages).toBe(progress.total_stages);
      expect(progress.provider_requests).toBe(
        chunks.length + merges.length + 1,
      );
      expect(completed.result.usage).toEqual({
        input_tokens: progress.provider_requests * 3,
        output_tokens: progress.provider_requests * 2,
        audio_ms: 0,
      });
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        settled_requests: String(progress.provider_requests),
        uncertain_requests: '0',
      });
      const selected = cited(completed.result.summary);
      expect(selected.source).toBe('transcript');
      const original = segments.find((segment) => segment.id === selected.id)!;
      const inspected = await db.summarySource(actor.user_id, job.id, selected);
      expect(inspected).toMatchObject({
        text: original.text,
        start_ms: original.start_ms,
        end_ms: original.end_ms,
      });
      await expect(
        db.summarySource(actor.user_id, job.id, {
          ...selected,
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'citation_not_found' });
    });
    it('does not repeat completed extraction after an explicitly resumed uncertain call', async () => {
      const { job } = await queued(101);
      const seen: number[] = [];
      let failed = false;
      const extract = fixture.extract!;
      const provider: AiProviders = {
        ...fixture,
        extract: async (chunk, signal, report) => {
          seen.push(chunk.index);
          if (chunk.index === 1 && !failed) {
            failed = true;
            throw new ServiceError(
              'provider_unavailable',
              'Synthetic lost extraction response.',
              503,
              true,
            );
          }
          return extract(chunk, signal, report);
        },
      };
      await runOnce(db, provider);
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
      });
      expect(await db.summaries.progress(actor.user_id, job.id)).toMatchObject({
        completed_stages: 1,
        uncertain_requests: 1,
      });
      expect(await runOnce(db, provider)).toBe(false);
      await resume(job.id);
      await runOnce(db, provider);
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'succeeded',
      });
      expect(seen.filter((index) => index === 0)).toHaveLength(1);
      expect(seen.filter((index) => index === 1)).toHaveLength(2);
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '1',
        uncertain: { input_tokens: '64000' },
      });
    });
    it('retains original indexed evidence after canonical transcript replacement', async () => {
      const { document, segments, job } = await queued(101);
      const extract = fixture.extract!;
      let changed = false;
      await runOnce(db, {
        ...fixture,
        extract: async (chunk, signal, report) => {
          if (!changed) {
            changed = true;
            await db.transaction((tx) =>
              db.transcripts.write(
                tx,
                actor.user_id,
                document.id,
                1,
                'manual',
                [
                  {
                    id: randomUUID(),
                    start_ms: 0,
                    end_ms: 100,
                    text: 'New unrelated canonical transcript.',
                  },
                ],
              ),
            );
          }
          return extract(chunk, signal, report);
        },
      });
      const completed = await db.job(actor.user_id, job.id);
      expect(completed).toMatchObject({
        state: 'succeeded',
        input_stale: true,
      });
      if (completed.result?.kind !== 'summary')
        throw new Error('Expected summary.');
      const selected = cited(completed.result.summary);
      expect(selected.revision).toBe(1);
      expect(
        (await db.summarySource(actor.user_id, job.id, selected)).text,
      ).toBe(segments.find((segment) => segment.id === selected.id)!.text);
    });
    it('publishes a saved final stage with its complete usage under a new configuration without repeating any model calls', async () => {
      const { job } = await queued(101);
      const finish = vi
        .spyOn(db, 'finish')
        .mockImplementationOnce(async (claimed) => {
          await db.pool.query(
            "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
            [claimed.id],
          );
          return false;
        });
      await runOnce(db, fixture);
      finish.mockRestore();
      const before = await db.summaries.progress(actor.user_id, job.id);
      const replacement = new Database(scopedUrl);
      const extract = vi.fn(fixture.extract!),
        merge = vi.fn(fixture.merge!),
        summarizeFacts = vi.fn(fixture.summarizeFacts!);
      try {
        await runOnce(replacement, {
          ...fixture,
          configurationVersion: 'replacement-v2',
          extract,
          merge,
          summarizeFacts,
        });
        expect(extract).not.toHaveBeenCalled();
        expect(merge).not.toHaveBeenCalled();
        expect(summarizeFacts).not.toHaveBeenCalled();
        expect(await db.job(actor.user_id, job.id)).toMatchObject({
          state: 'succeeded',
          result: {
            configuration_version: fixture.configurationVersion,
            usage: {
              input_tokens: before.provider_requests * 3,
              output_tokens: before.provider_requests * 2,
            },
          },
        });
      } finally {
        await replacement.close();
      }
    });
    it.each(['empty', 'foreign', 'oversized', 'empty merge'])(
      'fails explicitly on %s evidence instead of publishing a partial summary',
      async (failure) => {
        const { job } = await queued(101);
        const generate = vi.fn(fixture.summarizeFacts!);
        const extract = fixture.extract!;
        await runOnce(db, {
          ...fixture,
          summarizeFacts: generate,
          extract: async (chunk, signal, report) => {
            const value = await extract(chunk, signal, report);
            const facts: EvidenceFacts['facts'] =
              failure === 'empty'
                ? []
                : failure === 'foreign'
                  ? [
                      {
                        ...value.facts[0]!,
                        citations: [
                          {
                            source: 'transcript',
                            id: randomUUID(),
                            revision: 1,
                          },
                        ],
                      },
                    ]
                  : failure === 'oversized'
                    ? Array.from({ length: 6 }, () => ({
                        ...value.facts[0]!,
                        text: 'x'.repeat(2000),
                      }))
                    : value.facts;
            return { facts, usage: actual };
          },
          ...(failure === 'empty merge'
            ? { merge: async () => ({ facts: [], usage: actual }) }
            : {}),
        });
        expect(generate).not.toHaveBeenCalled();
        expect(await db.job(actor.user_id, job.id)).toMatchObject({
          state: 'failed',
          result: null,
          error: {
            code:
              failure === 'empty'
                ? 'insufficient_evidence'
                : failure === 'foreign'
                  ? 'invalid_citation'
                  : 'invalid_model_output',
          },
        });
        if (failure === 'empty')
          expect(
            (await db.summaries.progress(actor.user_id, job.id))
              .resume_available,
          ).toBe(false);
        expect(
          (await db.usage.snapshot(actor.user_id)).settled_requests,
        ).not.toBe('0');
      },
    );
    it('does not publish after late source corruption, and fences revocation between indexed pages', async () => {
      const { document, job } = await queued(101);
      const original = db.transcripts.page.bind(db.transcripts);
      vi.spyOn(db.transcripts, 'page').mockImplementation(async (...args) => {
        const value = await original(...args);
        if (value.offset >= 50) return { ...value, document_id: randomUUID() };
        return value;
      });
      const generate = vi.fn(fixture.summarizeFacts!);
      await runOnce(db, { ...fixture, summarizeFacts: generate });
      expect(generate).not.toHaveBeenCalled();
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
        result: null,
      });
      vi.restoreAllMocks();
      await resume(job.id);
      const extract = fixture.extract!;
      await runOnce(db, {
        ...fixture,
        summarizeFacts: generate,
        extract: async (chunk, signal, report) => {
          const result = await extract(chunk, signal, report);
          await db.pool.query(
            'UPDATE memberships SET active=false WHERE user_id=$1',
            [actor.user_id],
          );
          return result;
        },
      });
      expect(generate).not.toHaveBeenCalled();
      expect(
        (
          await db.pool.query('SELECT state,result FROM jobs WHERE id=$1', [
            job.id,
          ])
        ).rows[0],
      ).toEqual({ state: 'cancelled', result: null });
      expect(
        (
          await db.pool.query(
            'SELECT job_id FROM summary_runs WHERE job_id=$1',
            [job.id],
          )
        ).rowCount,
      ).toBe(0);
      await expect(db.document(actor.user_id, document.id)).rejects.toThrow();
    });
    it('chunks large Unicode notes without a transcript and preserves original note citations', async () => {
      const notes = '证据'.repeat(10_000);
      const { job, document } = await queued(0, notes);
      await runOnce(db, fixture);
      const completed = await db.job(actor.user_id, job.id);
      expect(completed.state).toBe('succeeded');
      if (completed.result?.kind !== 'summary')
        throw new Error('Expected notes-only summary.');
      const selected = cited(completed.result.summary);
      expect(selected).toEqual({
        source: 'note',
        id: document.id,
        revision: 1,
      });
      expect(
        (await db.summarySource(actor.user_id, job.id, selected)).text,
      ).toBe(notes);
    });
    it('retains the direct fast path for explicitly long-enabled input that already fits', async () => {
      const { document } = await source(0);
      const response = await enqueue(document, true, 0);
      expect(response.statusCode).toBe(202);
      const extract = vi.fn(fixture.extract!);
      const direct = vi.fn(
        async (snapshot: Parameters<AiProviders['summarize']>[0]) => ({
          summary: {
            overview: {
              text: 'Direct synthetic result.',
              citations: [
                {
                  source: 'note' as const,
                  id: snapshot.document_id,
                  revision: 1,
                },
              ],
            },
            topics: [],
            decisions: [],
            action_items: [],
            open_questions: [],
          },
          usage: actual,
        }),
      );
      await runOnce(db, { ...fixture, summarize: direct, extract });
      expect(direct).toHaveBeenCalledOnce();
      expect(extract).not.toHaveBeenCalled();
    });
    it('fails before reserving or dispatching when a worker lacks long-meeting support', async () => {
      const { job } = await queued(101);
      const { extract: _extract, ...unsupported } = fixture;
      await runOnce(db, unsupported);
      expect(await db.job(actor.user_id, job.id)).toMatchObject({
        state: 'failed',
        result: null,
        error: { code: 'summary_pipeline_unavailable' },
      });
      expect((await db.usage.snapshot(actor.user_id)).settled_requests).toBe(
        '0',
      );
      expect((await db.usage.snapshot(actor.user_id)).uncertain_requests).toBe(
        '0',
      );
    });
    it.each(['cancel', 'delete'] as const)(
      'purges indexed stage artifacts after %s while settling a late known extraction without publishing or dispatching again',
      async (action) => {
        const { document, job } = await queued(101);
        const original = fixture.extract!;
        const extract = vi.fn(async (...args: Parameters<typeof original>) => {
          const value = await original(...args);
          if (action === 'cancel') await db.cancel(actor.user_id, job.id);
          else await db.deleteDocument(actor.user_id, document.id);
          return value;
        });
        const merge = vi.fn(fixture.merge!),
          summarizeFacts = vi.fn(fixture.summarizeFacts!);
        await runOnce(db, { ...fixture, extract, merge, summarizeFacts });
        expect(extract).toHaveBeenCalledTimes(1);
        expect(merge).not.toHaveBeenCalled();
        expect(summarizeFacts).not.toHaveBeenCalled();
        expect(
          (
            await db.pool.query('SELECT state,result FROM jobs WHERE id=$1', [
              job.id,
            ])
          ).rows[0],
        ).toEqual({ state: 'cancelled', result: null });
        expect(
          (
            await db.pool.query(
              'SELECT job_id FROM summary_runs WHERE job_id=$1',
              [job.id],
            )
          ).rowCount,
        ).toBe(0);
        expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
          settled_requests: '1',
          uncertain_requests: '0',
        });
      },
    );
  },
);
