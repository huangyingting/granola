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
import { Database, type ClaimedChat } from '@windows-ai-notes/db';
import { runOnce } from '@windows-ai-notes/worker';
import {
  SUMMARY_USAGE_RESERVATION,
  type AiProviders,
} from '@windows-ai-notes/ai';
import { ServiceError } from '@windows-ai-notes/contracts/server';
import {
  chatTurnSchema,
  chatEventSchema,
  chatSourceSchema,
  questionPromptVersion,
  QUESTION_CONTEXT_PROMPT_VERSION,
  questionEvidenceSchema,
  type ChatSubmission,
  type QuestionEvidence,
  type ChatResult,
} from '@windows-ai-notes/contracts/questions';
import { SseDecoder } from '@windows-ai-notes/contracts/sse';
import { createServer } from './server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const actual = { input_tokens: 7, output_tokens: 4, audio_ms: 0 };
const answer = (input: QuestionEvidence) => ({
  answer: {
    text: 'Mira owns the checklist.',
    citations: [input.units[0]!.citation],
  },
  status: 'answered' as const,
});
describe.skipIf(!databaseUrl)(
  'durable current-meeting chat API and worker',
  { timeout: 30_000 },
  () => {
    const schema = `notes_chat_${randomUUID().replaceAll('-', '')}`;
    let admin: Database, db: Database;
    let app: Awaited<ReturnType<typeof createServer>>, base: string;
    let actor: { user_id: string; workspace_id: string },
      headers: { 'x-dev-subject': string };
    let providers: AiProviders;
    beforeAll(async () => {
      admin = new Database(databaseUrl!);
      await admin.pool.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = new Database(url.href);
      await db.migrate();
    });
    beforeEach(async () => {
      await app?.close();
      app = await createServer(db, { mode: 'development', host: '127.0.0.1' });
      base = await app.listen({ host: '127.0.0.1', port: 0 });
      await db.pool.query('TRUNCATE users,workspaces CASCADE');
      const subject = randomUUID();
      actor = await db.provision('urn:windows-ai-notes:development', subject);
      headers = { 'x-dev-subject': subject };
      providers = {
        provider: 'fixture',
        configurationVersion: 'chat-fixture-v1',
        answer: vi.fn<NonNullable<AiProviders['answer']>>(
          async (input, _signal, report, preview) => {
            await preview?.('Mira');
            await report?.(actual);
            return { answer: answer(input), usage: actual };
          },
        ),
        summarize: vi.fn<AiProviders['summarize']>(async (input) => ({
          summary: {
            overview: {
              text: 'Synthetic meeting summary.',
              citations: [
                {
                  source: 'note',
                  id: input.document_id,
                  revision: input.note_revision,
                },
              ],
            },
            topics: [],
            decisions: [],
            action_items: [],
            open_questions: [],
          },
          usage: actual,
        })),
        transcribe: async () => {
          throw new Error('Unexpected audio dispatch.');
        },
      };
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
    async function source(notes = 'Mira owns the checklist.') {
      return db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic chat meeting',
          notes,
        },
        randomUUID(),
      );
    }
    const body = (extra: Partial<ChatSubmission> = {}): ChatSubmission => ({
      note_revision: 1,
      transcript_revision: 0,
      language: 'en',
      question: 'Who owns the checklist?',
      confirmed: true,
      ...extra,
    });
    async function post(
      document: string,
      request = body(),
      key = randomUUID(),
    ) {
      return app.inject({
        method: 'POST',
        url: `/v1/documents/${document}/chat-turns`,
        headers: { ...headers, 'idempotency-key': key },
        payload: request,
      });
    }
    async function accepted(
      document: string,
      request = body(),
      key = randomUUID(),
    ) {
      const response = await post(document, request, key);
      expect(response.statusCode, response.body).toBe(202);
      return chatTurnSchema.parse(response.json());
    }
    async function sending(claim: ClaimedChat) {
      return db.chat.sending(claim, {
        operation: 'question-answer',
        provider: providers.provider,
        configurationVersion: providers.configurationVersion,
        budget: SUMMARY_USAGE_RESERVATION,
      });
    }
    const result = (claim: ClaimedChat): ChatResult => ({
      answer: answer(claim.evidence),
      provider: providers.provider,
      configuration_version: providers.configurationVersion,
      prompt_version: questionPromptVersion(claim.evidence),
      usage: actual,
    });
    async function recover(id: string, token: string) {
      return app.inject({
        method: 'POST',
        url: `/v1/chat-turns/${id}/resume`,
        headers,
        payload: { confirmed: true, resume_token: token },
      });
    }
    it('accepts a frozen question, completes a cited answer, and leaves strict legacy jobs and sync untouched', async () => {
      const document = await source();
      const snapshot = await db.sync.snapshot(
        actor.user_id,
        actor.workspace_id,
        undefined,
        undefined,
        10,
      );
      const turn = await accepted(document.id);
      expect(turn).toMatchObject({
        state: 'queued',
        attempt: 0,
        provider_requests: 0,
        result: null,
      });
      expect(await db.jobs(actor.user_id, document.id)).toEqual([]);
      expect(
        (
          await db.sync.changes(
            actor.user_id,
            actor.workspace_id,
            snapshot.cursor,
            50,
          )
        ).changes,
      ).toEqual([]);
      expect(await runOnce(db, providers)).toBe(true);
      const complete = await db.chat.get(actor.user_id, turn.id);
      expect(complete).toMatchObject({
        state: 'succeeded',
        provider_requests: 1,
        uncertain_requests: 0,
        resume_available: false,
        result: { answer: { status: 'answered' }, usage: actual },
      });
      expect(
        (await app.inject({ url: `/v1/jobs/${turn.id}`, headers })).statusCode,
      ).toBe(404);
      expect((await db.usage.snapshot(actor.user_id)).settled_requests).toBe(
        '1',
      );
      expect(providers.answer).toHaveBeenCalledTimes(1);
      expect(await runOnce(db, providers)).toBe(false);
    });
    it('recovers lost enqueue receipts before rebuilding changed revisions and binds the original request', async () => {
      const document = await source(),
        key = randomUUID(),
        request = body({ language: 'zh' });
      const first = await accepted(document.id, request, key);
      await db.edit(
        actor.user_id,
        document.id,
        1,
        { notes: 'Changed current notes.' },
        randomUUID(),
      );
      const rebuild = vi.spyOn(db.questions, 'evidence');
      const recovered = await accepted(document.id, request, key);
      expect(recovered.id).toBe(first.id);
      expect(recovered.input_stale).toBe(true);
      expect(recovered.request).toEqual(request);
      expect(rebuild).not.toHaveBeenCalled();
      expect(
        (await post(document.id, body({ note_revision: 2 }), key)).statusCode,
      ).toBe(409);
      await runOnce(db, providers);
      expect(
        vi.mocked(providers.answer!).mock.calls[0]![0].units[0]!.text,
      ).toBe(document.notes);
    });
    it('freezes bounded same-thread conversation context without treating earlier answers as new source citations', async () => {
      const document = await source();
      const first = await accepted(document.id);
      await runOnce(db, providers);
      await db.edit(
        actor.user_id,
        document.id,
        1,
        { notes: 'Mira owns the checklist. The deadline is Friday.' },
        randomUUID(),
      );
      const followup = await accepted(
        document.id,
        body({
          thread_id: first.thread_id,
          note_revision: 2,
          question: 'When is it due?',
        }),
      );
      const claim = (await db.chat.claim())!;
      expect(claim.evidence.context).toEqual({
        version: 'meeting-question-context-v1',
        turns: [
          {
            question: first.request.question,
            answer: 'Mira owns the checklist.',
          },
        ],
      });
      expect(questionPromptVersion(claim.evidence)).toBe(
        QUESTION_CONTEXT_PROMPT_VERSION,
      );
      expect(
        claim.evidence.units.every((unit) => unit.citation.revision === 2),
      ).toBe(true);
      await db.chat.fail(claim, {
        code: 'synthetic',
        message: 'Explicit test failure.',
        retryable: false,
      });
      const history = await db.chat.history(actor.user_id, first.thread_id, 0);
      expect(history.turns.map((turn) => turn.id)).toEqual([
        first.id,
        followup.id,
      ]);
      expect(
        (await db.chat.threads(actor.user_id, document.id, 0)).threads[0]!
          .last_position,
      ).toBe(2);
    });
    it('requires explicit consent and rejects client-supplied evidence, context, URLs and cross-meeting threads', async () => {
      const document = await source(),
        other = await source();
      const turn = await accepted(document.id);
      for (const payload of [
        { ...body(), confirmed: false },
        { ...body(), context: {} },
        { ...body(), evidence: {} },
        { ...body(), provider_url: 'https://example.com' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/documents/${other.id}/chat-turns`,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(
        (await post(other.id, body({ thread_id: turn.thread_id }))).statusCode,
      ).toBe(404);
      expect(
        (await post(document.id, body({ thread_id: turn.thread_id })))
          .statusCode,
      ).toBe(409);
      expect(
        (await app.inject({ url: '/v1/chat-capabilities' })).statusCode,
      ).toBe(401);
    });
    it('serializes concurrent dispatch reservations and rolls back a reservation with its sending marker', async () => {
      const turn = await accepted((await source()).id);
      const claim = (await db.chat.claim())!;
      const reserve = db.usage.startChat.bind(db.usage);
      vi.spyOn(db.usage, 'startChat').mockImplementationOnce(
        async (...args) => {
          await reserve(...args);
          throw new ServiceError(
            'synthetic_rollback',
            'Synthetic transaction rollback.',
            503,
          );
        },
      );
      await expect(sending(claim)).rejects.toMatchObject({
        code: 'synthetic_rollback',
      });
      expect(
        (await db.pool.query('SELECT id FROM ai_usage_calls')).rowCount,
      ).toBe(0);
      const outcomes = await Promise.allSettled([
        sending(claim),
        sending(claim),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        (await db.chat.get(actor.user_id, turn.id)).uncertain_requests,
      ).toBe(1);
    });
    it('does not automatically resend an abandoned provider call and consumes recovery consent only once', async () => {
      const turn = await accepted((await source()).id);
      const claim = (await db.chat.claim())!;
      await sending(claim);
      await db.pool.query(
        "UPDATE chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1",
        [turn.id],
      );
      expect(await runOnce(db, providers)).toBe(false);
      const failed = await db.chat.get(actor.user_id, turn.id);
      expect(failed).toMatchObject({
        state: 'failed',
        uncertain_requests: 1,
        resume_available: true,
      });
      expect(providers.answer).not.toHaveBeenCalled();
      const replies = await Promise.all([
        recover(turn.id, failed.resume_token!),
        recover(turn.id, failed.resume_token!),
      ]);
      expect(replies.map((reply) => reply.statusCode)).toEqual([202, 202]);
      expect((await db.pool.query('SELECT * FROM chat_resumes')).rowCount).toBe(
        1,
      );
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'succeeded',
        attempt: 2,
        provider_requests: 2,
        uncertain_requests: 1,
      });
      expect(providers.answer).toHaveBeenCalledTimes(1);
      expect((await recover(turn.id, failed.resume_token!)).statusCode).toBe(
        202,
      );
      expect(await runOnce(db, providers)).toBe(false);
      expect((await db.usage.snapshot(actor.user_id)).uncertain_requests).toBe(
        '1',
      );
    });
    it('retains known usage after invalid citations without publishing the draft as an answer', async () => {
      const turn = await accepted((await source()).id);
      vi.mocked(providers.answer!).mockImplementationOnce(
        async (_input, _signal, report, preview) => {
          await preview?.('Unverified draft');
          await report?.(actual);
          return {
            answer: {
              status: 'answered',
              answer: {
                text: 'Unsupported.',
                citations: [{ source: 'note', id: randomUUID(), revision: 1 }],
              },
            },
            usage: actual,
          };
        },
      );
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'failed',
        result: null,
        provider_requests: 1,
        uncertain_requests: 0,
        error: { code: 'invalid_citation' },
      });
      expect(
        (
          await db.pool.query(
            'SELECT preview_text FROM chat_turns WHERE id=$1',
            [turn.id],
          )
        ).rows[0]!.preview_text,
      ).toBeNull();
      expect(
        (await db.chat.events(actor.user_id, turn.id, 0)).events.some(
          (event) => event.event_type === 'answer.completed',
        ),
      ).toBe(false);
    });
    it('requires an exact settled usage and provider receipt before publishing any final answer', async () => {
      await accepted((await source()).id);
      const claim = (await db.chat.claim())!,
        call = await sending(claim);
      await expect(
        db.chat.complete(claim, result(claim)),
      ).rejects.toMatchObject({ code: 'question_receipt_mismatch' });
      await db.usage.settle(call, actual);
      await expect(
        db.chat.complete(claim, {
          ...result(claim),
          configuration_version: 'changed',
        }),
      ).rejects.toMatchObject({ code: 'question_receipt_mismatch' });
      await db.chat.complete(claim, result(claim));
      expect((await db.chat.get(actor.user_id, claim.id)).state).toBe(
        'succeeded',
      );
    });
    it('handles empty meeting evidence explicitly without reserving or sending a paid request', async () => {
      const turn = await accepted(
        (await source('')).id,
        body({ language: 'zh' }),
      );
      delete providers.answer;
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'succeeded',
        provider_requests: 0,
        result: {
          answer: {
            status: 'insufficient_evidence',
            answer: { citations: [] },
          },
        },
      });
      expect(
        (await db.pool.query('SELECT id FROM ai_usage_calls')).rowCount,
      ).toBe(0);
    });
    it.each(['cancel', 'thread', 'document', 'membership', 'account'] as const)(
      'fences late answers after %s while retaining known usage',
      async (action) => {
        const document = await source(),
          turn = await accepted(document.id);
        vi.mocked(providers.answer!).mockImplementationOnce(
          async (input, _signal, report, preview) => {
            await preview?.('Unverified');
            if (action === 'cancel')
              await db.chat.cancel(actor.user_id, turn.id);
            if (action === 'thread')
              await db.chat.remove(actor.user_id, turn.thread_id);
            if (action === 'document')
              await db.deleteDocument(actor.user_id, document.id);
            if (action === 'membership')
              await db.pool.query(
                'UPDATE memberships SET active=false WHERE user_id=$1',
                [actor.user_id],
              );
            if (action === 'account')
              await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
                actor.user_id,
              ]);
            await report?.(actual);
            return { answer: answer(input), usage: actual };
          },
        );
        await runOnce(db, providers);
        if (action === 'account')
          await db.pool.query('UPDATE users SET active=true WHERE id=$1', [
            actor.user_id,
          ]);
        if (action === 'membership')
          await db.pool.query(
            'UPDATE memberships SET active=true WHERE user_id=$1',
            [actor.user_id],
          );
        expect((await db.usage.snapshot(actor.user_id)).settled_requests).toBe(
          '1',
        );
        if (action === 'thread' || action === 'document') {
          await expect(
            db.chat.get(actor.user_id, turn.id),
          ).rejects.toMatchObject({ code: 'chat_not_found' });
          expect(
            (await db.pool.query('SELECT chat_turn_id FROM ai_usage_calls'))
              .rows[0]!.chat_turn_id,
          ).toBeNull();
        } else
          expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
            state: 'cancelled',
            result: null,
            resume_available: false,
          });
        expect(
          (
            await db.pool.query(
              "SELECT * FROM chat_events WHERE event_type='answer.completed'",
            )
          ).rowCount,
        ).toBe(0);
      },
    );
    it('prevents an old accepted request from recreating a deleted conversation', async () => {
      const document = await source(),
        key = randomUUID(),
        request = body();
      const turn = await accepted(document.id, request, key);
      await db.chat.remove(actor.user_id, turn.thread_id);
      const replay = await post(document.id, request, key);
      expect(replay.statusCode).toBe(410);
      expect(replay.json().code).toBe('chat_request_deleted');
      expect(
        (await db.pool.query('SELECT id FROM chat_threads')).rowCount,
      ).toBe(0);
      expect((await db.pool.query('SELECT id FROM chat_turns')).rowCount).toBe(
        0,
      );
    });
    it('drains every terminal replay batch and returns a coherent snapshot when history expires', async () => {
      const turn = await accepted((await source()).id),
        claim = (await db.chat.claim())!;
      const call = await sending(claim);
      for (let count = 1; count <= 60; count++)
        await db.chat.preview(claim, 'x'.repeat(count));
      await db.usage.settle(call, actual);
      await db.chat.complete(claim, result(claim));
      const state = await db.chat.get(actor.user_id, turn.id);
      const response = await fetch(`${base}/v1/chat-turns/${turn.id}/events`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      expect(response.ok).toBe(true);
      const decoder = new SseDecoder();
      const frames = [
        ...decoder.push(new TextEncoder().encode(await response.text())),
        ...decoder.finish(),
      ];
      const events = frames.map((frame) =>
        chatEventSchema.parse(JSON.parse(frame.data)),
      );
      expect(events).toHaveLength(state.last_event_id);
      expect(events.at(-1)!.event_type).toBe('answer.completed');
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: state.last_event_id }, (_, index) => index + 1),
      );
      await db.pool.query(
        'DELETE FROM chat_events WHERE turn_id=$1 AND seq<50',
        [turn.id],
      );
      const expired = await app.inject({
        url: `/v1/chat-turns/${turn.id}/events`,
        headers,
      });
      expect(expired.statusCode).toBe(410);
      const snapshot = await app.inject({
        url: `/v1/chat-turns/${turn.id}/event-state`,
        headers,
      });
      expect(snapshot.json().turn).toEqual(state);
    });
    it('inspects only completed cited frozen sources after current-note replacement and cache/event expiry', async () => {
      const document = await source(),
        turn = await accepted(document.id);
      await runOnce(db, providers);
      const complete = await db.chat.get(actor.user_id, turn.id);
      const citation = complete.result!.answer.answer.citations[0]!;
      await db.edit(
        actor.user_id,
        document.id,
        1,
        { notes: 'Replaced current note.' },
        randomUUID(),
      );
      await db.pool.query(
        "UPDATE chat_turns SET expires_at=now()-interval '8 days' WHERE id=$1",
        [turn.id],
      );
      await db.pool.query(
        "UPDATE chat_events SET created_at=now()-interval '8 days' WHERE turn_id=$1",
        [turn.id],
      );
      await db.cleanup();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chat-turns/${turn.id}/citation`,
        headers,
        payload: citation,
      });
      expect(response.statusCode).toBe(200);
      expect(chatSourceSchema.parse(response.json()).excerpts[0]!.text).toBe(
        document.notes,
      );
      expect((await db.chat.get(actor.user_id, turn.id)).input_stale).toBe(
        true,
      );
      expect((await db.chat.get(actor.user_id, turn.id)).result).toEqual(
        complete.result,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/chat-turns/${turn.id}/citation`,
            headers,
            payload: { ...citation, revision: 2 },
          })
        ).statusCode,
      ).toBe(404);
      expect(providers.answer).toHaveBeenCalledTimes(1);
    });
    it('expires unfinished question inputs without releasing uncertain billing or recreating work', async () => {
      const turn = await accepted((await source()).id),
        claim = (await db.chat.claim())!;
      await sending(claim);
      await db.chat.fail(claim, {
        code: 'provider_unavailable',
        message: 'Synthetic uncertainty.',
        retryable: false,
      });
      await db.pool.query(
        "UPDATE chat_turns SET expires_at=now()-interval '1 second' WHERE id=$1",
        [turn.id],
      );
      await db.cleanup();
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'failed',
        resume_available: false,
        error: { code: 'question_progress_expired' },
        uncertain_requests: 1,
      });
      expect(
        (
          await db.pool.query('SELECT evidence FROM chat_turns WHERE id=$1', [
            turn.id,
          ])
        ).rows[0]!.evidence,
      ).toBeNull();
      expect(await runOnce(db, providers)).toBe(false);
      expect((await db.usage.snapshot(actor.user_id)).uncertain_requests).toBe(
        '1',
      );
    });
    it('bounds retries and rejects stale recovery tokens without consuming current consent', async () => {
      const turn = await accepted((await source()).id);
      vi.mocked(providers.answer!).mockRejectedValue(
        new ServiceError(
          'provider_unavailable',
          'Synthetic uncertainty.',
          503,
          true,
        ),
      );
      const tokens: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        await runOnce(db, providers);
        const current = await db.chat.get(actor.user_id, turn.id);
        expect(current.attempt).toBe(attempt);
        expect(current.provider_requests).toBe(attempt);
        if (attempt < 3) {
          tokens.push(current.resume_token!);
          expect((await recover(turn.id, randomUUID())).statusCode).toBe(409);
          if (attempt === 2) {
            expect((await recover(turn.id, tokens[0]!)).statusCode).toBe(202);
            expect((await db.chat.get(actor.user_id, turn.id)).state).toBe(
              'failed',
            );
          }
          expect(
            (await recover(turn.id, current.resume_token!)).statusCode,
          ).toBe(202);
        } else expect(current.resume_available).toBe(false);
      }
      expect(providers.answer).toHaveBeenCalledTimes(3);
      expect(await runOnce(db, providers)).toBe(false);
      expect((await db.usage.snapshot(actor.user_id)).uncertain_requests).toBe(
        '3',
      );
    });
    it('enforces one shared pending-work cap for new chat and old summary jobs', async () => {
      const document = await source();
      const replies = await Promise.all(
        Array.from({ length: 9 }, () => post(document.id)),
      );
      expect(replies.filter((reply) => reply.statusCode === 202)).toHaveLength(
        8,
      );
      expect(replies.filter((reply) => reply.statusCode === 429)).toHaveLength(
        1,
      );
      await expect(
        db.enqueueSummary(
          actor.user_id,
          document.id,
          {
            note_revision: 1,
            transcript_revision: 0,
            language: 'en',
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
    });
    it('fences old workers after lease replacement and rejects corrupted input before another provider call', async () => {
      const turn = await accepted((await source()).id),
        claim = (await db.chat.claim())!;
      await sending(claim);
      await db.pool.query(
        'UPDATE chat_turns SET lease_token=lease_token+1 WHERE id=$1',
        [turn.id],
      );
      await expect(db.chat.preview(claim, 'Late text')).rejects.toMatchObject({
        code: 'chat_lease_lost',
      });
      await db.pool.query(
        "UPDATE chat_turns SET lease_until=now()-interval '1 second',evidence=jsonb_set(evidence,'{question}','\"Changed\"') WHERE id=$1",
        [turn.id],
      );
      expect(await runOnce(db, providers)).toBe(false);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'failed',
        resume_available: false,
        error: { code: 'question_input_changed' },
      });
      expect(providers.answer).not.toHaveBeenCalled();
    });
    it('does not starve older legacy work or mix question turns into legacy result contracts', async () => {
      const document = await source();
      const summary = await db.enqueueSummary(
        actor.user_id,
        document.id,
        {
          note_revision: 1,
          transcript_revision: 0,
          language: 'en',
        },
        randomUUID(),
      );
      const question = await accepted(document.id);
      await runOnce(db, providers);
      expect((await db.job(actor.user_id, summary.id)).state).toBe('succeeded');
      expect((await db.chat.get(actor.user_id, question.id)).state).toBe(
        'queued',
      );
      await runOnce(db, providers);
      expect((await db.chat.get(actor.user_id, question.id)).state).toBe(
        'succeeded',
      );
      expect(
        (await db.jobs(actor.user_id, document.id)).map((job) => job.id),
      ).toEqual([summary.id]);
    });
    it('rejects every cross-account history, control, stream and source operation', async () => {
      const document = await source(),
        turn = await accepted(document.id);
      await runOnce(db, providers);
      const subject = randomUUID();
      await db.provision('urn:windows-ai-notes:development', subject);
      const foreign = { 'x-dev-subject': subject };
      for (const url of [
        `/v1/chat-turns/${turn.id}`,
        `/v1/chat-turns/${turn.id}/event-state`,
        `/v1/chat-turns/${turn.id}/events`,
        `/v1/chat-threads/${turn.thread_id}/turns`,
        `/v1/documents/${document.id}/chat-threads`,
      ])
        expect((await app.inject({ url, headers: foreign })).statusCode).toBe(
          404,
        );
      for (const [path, payload] of [
        ['cancel', { confirmed: true }],
        ['resume', { confirmed: true, resume_token: randomUUID() }],
        ['citation', { source: 'note', id: document.id, revision: 1 }],
      ] as const)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/v1/chat-turns/${turn.id}/${path}`,
              headers: foreign,
              payload,
            })
          ).statusCode,
        ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/chat-threads/${turn.thread_id}`,
            headers: foreign,
            payload: { confirmed: true },
          })
        ).statusCode,
      ).toBe(404);
      expect((await db.chat.get(actor.user_id, turn.id)).state).toBe(
        'succeeded',
      );
    });
    it('reclaims a lease abandoned before dispatch without fabricating an uncertain charge', async () => {
      const turn = await accepted((await source()).id),
        old = (await db.chat.claim())!;
      await db.pool.query(
        "UPDATE chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1",
        [turn.id],
      );
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'succeeded',
        attempt: 2,
        provider_requests: 1,
        uncertain_requests: 0,
      });
      expect(await db.chat.renew(old)).toBe(false);
      expect(providers.answer).toHaveBeenCalledTimes(1);
    });
    it('rejects provider-configuration substitution after explicit recovery without reserving another call', async () => {
      const turn = await accepted((await source()).id),
        claim = (await db.chat.claim())!;
      await sending(claim);
      await db.chat.fail(claim, {
        code: 'provider_unavailable',
        message: 'Synthetic uncertainty.',
        retryable: false,
      });
      const failed = await db.chat.get(actor.user_id, turn.id);
      await recover(turn.id, failed.resume_token!);
      providers = {
        ...providers,
        configurationVersion: 'changed-deployment-v2',
      };
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'failed',
        resume_available: false,
        provider_requests: 1,
        error: { code: 'question_identity_changed' },
      });
      expect(providers.answer).not.toHaveBeenCalled();
    });
    it('does not consume recovery consent when the shared pending-work budget is full', async () => {
      const document = await source(),
        turn = await accepted(document.id),
        claim = (await db.chat.claim())!;
      await sending(claim);
      await db.chat.fail(claim, {
        code: 'provider_unavailable',
        message: 'Synthetic uncertainty.',
        retryable: false,
      });
      const failed = await db.chat.get(actor.user_id, turn.id);
      const pending = await Promise.all(
        Array.from({ length: 8 }, () => accepted(document.id)),
      );
      expect((await recover(turn.id, failed.resume_token!)).statusCode).toBe(
        429,
      );
      expect((await db.chat.get(actor.user_id, turn.id)).resume_token).toBe(
        failed.resume_token,
      );
      expect((await db.pool.query('SELECT * FROM chat_resumes')).rowCount).toBe(
        0,
      );
      await db.chat.cancel(actor.user_id, pending[0]!.id);
      expect((await recover(turn.id, failed.resume_token!)).statusCode).toBe(
        202,
      );
    });
    it('requires a new question when a later question supersedes a failed turn', async () => {
      const document = await source(),
        first = await accepted(document.id),
        claim = (await db.chat.claim())!;
      await db.chat.fail(claim, {
        code: 'synthetic',
        message: 'Synthetic failure before dispatch.',
        retryable: false,
      });
      const failed = await db.chat.get(actor.user_id, first.id);
      await accepted(
        document.id,
        body({
          thread_id: first.thread_id,
          question: 'When is the checklist due?',
        }),
      );
      expect(
        (await db.chat.get(actor.user_id, first.id)).resume_available,
      ).toBe(false);
      expect((await recover(first.id, failed.resume_token!)).statusCode).toBe(
        409,
      );
    });
    it('does not send a model request when the account allowance rejects the atomic reservation', async () => {
      const turn = await accepted((await source()).id);
      await db.usage.snapshot(actor.user_id);
      await db.pool.query(
        'UPDATE ai_usage_accounts SET limits=$2 WHERE owner_id=$1',
        [
          actor.user_id,
          JSON.stringify({ input_tokens: 0, output_tokens: 0, audio_ms: 0 }),
        ],
      );
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'failed',
        provider_requests: 0,
        error: { code: 'quota_exceeded' },
      });
      expect(providers.answer).not.toHaveBeenCalled();
    });
    it('does not promote older conversation answers into evidence when current meeting sources are empty', async () => {
      const document = await source(),
        first = await accepted(document.id);
      await runOnce(db, providers);
      await accepted(
        document.id,
        body({ thread_id: first.thread_id, question: 'Which checklist?' }),
      );
      await runOnce(db, providers);
      await db.edit(actor.user_id, document.id, 1, { notes: '' }, randomUUID());
      const latest = await accepted(
        document.id,
        body({
          thread_id: first.thread_id,
          note_revision: 2,
          question: 'Who is responsible?',
        }),
      );
      const input = questionEvidenceSchema.parse(
        (
          await db.pool.query('SELECT evidence FROM chat_turns WHERE id=$1', [
            latest.id,
          ])
        ).rows[0]!.evidence,
      );
      expect(input.context!.turns).toHaveLength(2);
      expect(input.units).toEqual([]);
      await runOnce(db, providers);
      expect(await db.chat.get(actor.user_id, latest.id)).toMatchObject({
        state: 'succeeded',
        provider_requests: 0,
        result: { answer: { status: 'insufficient_evidence' } },
      });
      expect(providers.answer).toHaveBeenCalledTimes(2);
    });
    it('exhausts pre-dispatch crash attempts without falsely claiming an uncertain provider charge', async () => {
      const turn = await accepted((await source()).id);
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect((await db.chat.claim())!.id).toBe(turn.id);
        await db.pool.query(
          "UPDATE chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1",
          [turn.id],
        );
      }
      expect(await runOnce(db, providers)).toBe(false);
      expect(await db.chat.get(actor.user_id, turn.id)).toMatchObject({
        state: 'failed',
        provider_requests: 0,
        resume_available: false,
        error: { code: 'question_attempts_exhausted' },
      });
      expect(providers.answer).not.toHaveBeenCalled();
    });
    it('shares the two-subscription budget between chat and legacy job streams', async () => {
      const document = await source(),
        turn = await accepted(document.id);
      const summary = await db.enqueueSummary(
        actor.user_id,
        document.id,
        {
          note_revision: 1,
          transcript_revision: 0,
          language: 'en',
        },
        randomUUID(),
      );
      const first = new AbortController(),
        second = new AbortController();
      let chat: Response | undefined, job: Response | undefined;
      try {
        chat = await fetch(`${base}/v1/chat-turns/${turn.id}/events`, {
          headers,
          signal: first.signal,
        });
        job = await fetch(`${base}/v1/jobs/${summary.id}/events`, {
          headers,
          signal: second.signal,
        });
        expect(chat.ok && job.ok).toBe(true);
        expect(
          (
            await app.inject({
              url: `/v1/chat-turns/${turn.id}/events`,
              headers,
            })
          ).statusCode,
        ).toBe(429);
      } finally {
        await chat?.body?.cancel();
        await job?.body?.cancel();
        first.abort();
        second.abort();
      }
    });
  },
);
