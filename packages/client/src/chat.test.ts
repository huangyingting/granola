import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { z } from 'zod';
import { createServer } from '@windows-ai-notes/api/server';
import { Database } from '@windows-ai-notes/db';
import { LocalStore } from '@windows-ai-notes/local';
import { runOnce } from '@windows-ai-notes/worker';
import { ServiceError, citationKey } from '@windows-ai-notes/contracts/server';
import { richTextFromPlainText } from '@windows-ai-notes/contracts/content';
import {
  chatRecoveryViewSchema,
  chatSourceSchema,
  chatTurnPageSchema,
  questionPromptVersion,
  type ChatTurn,
} from '@windows-ai-notes/contracts/questions';
import {
  desktopCommandSchema,
  desktopResponseSchema,
} from '@windows-ai-notes/contracts/desktop';
import { WorkspaceController } from './workspace.js';
import { oidcFixture } from './oidc.fixture.js';
import { chatIntentSchema } from './chat.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Main-owned desktop chat with the real provisioned API and worker',
  () => {
    const schema = `notes_desktop_chat_${randomUUID().replaceAll('-', '')}`;
    let admin: Database,
      db: Database,
      local: LocalStore,
      controller: WorkspaceController;
    let app: Awaited<ReturnType<typeof createServer>>,
      issuer: Awaited<ReturnType<typeof oidcFixture>>;
    let directory: string, key: Buffer, base: string;
    let actor: { user_id: string; workspace_id: string };
    let answer: ReturnType<
      typeof vi.fn<NonNullable<Parameters<typeof runOnce>[1]['answer']>>
    >;
    const open = () =>
      new WorkspaceController(local, issuer.browser, () => {}, {
        allowLoopback: true,
      });
    const fields = (text: string) => ({
      title: 'Synthetic chat meeting',
      tags: [],
      content: richTextFromPlainText(text),
    });
    const providers = () => ({
      provider: 'fixture' as const,
      configurationVersion: 'desktop-chat-fixture-v1',
      transcribe: async () => {
        throw new Error('Unexpected audio dispatch.');
      },
      summarize: async () => {
        throw new Error('Unexpected summary dispatch.');
      },
      answer,
    });
    const command = (id: string) => ({
      operation: 'askMeeting' as const,
      scope: controller.scope,
      id,
      question: 'Who owns the launch checklist?',
      language: 'en' as const,
      confirmed: true as const,
      new_attempt: true,
      consent_id: randomUUID(),
    });
    const readCommand = (id: string, refresh = true) => ({
      operation: 'getChat' as const,
      scope: controller.scope,
      id,
      offset: 0,
      refresh,
    });
    const control = (turn: ChatTurn, action: 'cancel' | 'resume') => ({
      operation: 'controlChatTurn' as const,
      scope: controller.scope,
      id: turn.document_id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      confirmed: true as const,
      action,
      ...(action === 'resume' ? { resume_token: turn.resume_token! } : {}),
    });
    const sourceCommand = (turn: ChatTurn) => ({
      operation: 'getChatSource' as const,
      scope: controller.scope,
      id: turn.document_id,
      thread_id: turn.thread_id,
      turn_id: turn.id,
      citation: turn.result!.answer.answer.citations[0]!,
    });
    const removeCommand = (turn: ChatTurn) => ({
      operation: 'deleteChatThread' as const,
      scope: controller.scope,
      id: turn.document_id,
      thread_id: turn.thread_id,
      confirmed: true as const,
    });
    const watch = (turn: ChatTurn) =>
      controller.chat.watch({
        operation: 'watchChat',
        scope: controller.scope,
        id: turn.document_id,
        thread_id: turn.thread_id,
        turn_id: turn.id,
        action: 'start',
      });
    const eventArtifact = (turn: ChatTurn) =>
      `chat-thread:${turn.thread_id}:events:${turn.id}`;
    async function connect(
      text = 'Mira owns the launch checklist. It is due Friday.',
    ) {
      const document = await db.createDocument(
        actor.user_id,
        {
          workspace_id: actor.workspace_id,
          title: 'Synthetic chat meeting',
          notes: text,
        },
        randomUUID(),
      );
      await controller.execute({
        operation: 'connect',
        scope: controller.scope,
        service_url: base,
      });
      await controller.execute({
        operation: 'activateWorkspace',
        scope: controller.scope,
        workspace_id: actor.workspace_id,
        copy_offline: false,
      });
      await controller.synchronize();
      return document;
    }
    async function finish(turn: ChatTurn) {
      expect(await runOnce(db, providers())).toBe(true);
      await controller.chat.read(readCommand(turn.document_id));
      return db.chat.get(actor.user_id, turn.id);
    }
    async function fail(turn: ChatTurn) {
      answer.mockRejectedValueOnce(
        new ServiceError(
          'provider_unavailable',
          'Synthetic lost model reply.',
          503,
          true,
        ),
      );
      expect(await runOnce(db, providers())).toBe(true);
      await controller.chat.read(readCommand(turn.document_id));
      return db.chat.get(actor.user_id, turn.id);
    }
    function restart() {
      controller.dispose();
      local.close();
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
    }
    it('does not roll back a saved answer or lose a newer accepted question when an older history response arrives late', async () => {
      const document = await connect(),
        first = await controller.chat.start(command(document.id)),
        original = globalThis.fetch;
      let release!: () => void,
        reached!: () => void,
        hold = true;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).includes('/turns?after=') && hold) {
          hold = false;
          reached();
          await gate;
        }
        return response;
      });
      const older = controller.chat.read(readCommand(document.id));
      await ready;
      try {
        await finish(first);
        const next = await controller.chat.start({
          ...command(document.id),
          thread_id: first.thread_id,
          question: 'When is it due?',
        });
        release();
        const view = await older;
        expect(view.turns.map((turn) => turn.id)).toEqual([first.id, next.id]);
        expect(view.turns[0]?.state).toBe('succeeded');
        expect(view.turns[1]?.state).toBe('queued');
        expect(view.history_complete).toBe(true);
      } finally {
        release();
      }
    });
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
      issuer = await oidcFixture();
      actor = await db.provision(
        issuer.configuration.issuer,
        issuer.state.subject,
      );
      app = await createServer(db, {
        mode: 'oidc',
        host: '127.0.0.1',
        issuer: issuer.configuration.issuer,
        audience: issuer.configuration.audience,
        jwksUrl: `${issuer.state.issuer}keys`,
        requiredScope: 'notes.access',
        desktop: issuer.configuration,
      });
      base = await app.listen({ host: '127.0.0.1', port: 0 });
      directory = mkdtempSync(join(tmpdir(), 'windows-notes-chat-'));
      key = randomBytes(32);
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
      controller = open();
      answer = vi.fn<NonNullable<Parameters<typeof runOnce>[1]['answer']>>(
        async (input) => ({
          answer: {
            status: 'answered',
            answer: {
              text: 'Mira owns the checklist; Friday is the deadline.',
              citations: [input.units[0]!.citation],
            },
          },
          usage: { input_tokens: 70, output_tokens: 18, audio_ms: 0 },
        }),
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      controller?.dispose();
      await app?.close();
      await issuer?.close();
      local?.close();
      key?.fill(0);
      rmSync(directory, { recursive: true, force: true });
      expect(issuer.state.failures).toEqual([]);
    });
    afterAll(async () => {
      await db?.close();
      await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    });

    it('replays encrypted unfinished answer cursors across a real Main-store restart, then commits only the validated final answer', async () => {
      const document = await connect(),
        turn = await controller.chat.start(command(document.id));
      const complete = answer.getMockImplementation();
      if (!complete)
        throw new Error('Missing synthetic answer implementation.');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const text = 'Unfinished cited answer, not yet validated.';
      answer.mockImplementationOnce(async (...args) => {
        if (!args[3]) throw new Error('Missing chat preview reporter.');
        await args[3](text);
        await gate;
        return complete(...args);
      });
      await watch(turn);
      const work = runOnce(db, providers());
      try {
        await vi.waitFor(
          () =>
            expect(controller.snapshot().chat_generation?.preview).toBe(text),
          { timeout: 10_000 },
        );
        const cursor = controller.snapshot().chat_generation!.last_event_id;
        expect(
          (await controller.chat.read(readCommand(document.id, false))).turns[0]
            ?.result,
        ).toBeNull();
        await expect(
          controller.chat.source({
            operation: 'getChatSource',
            scope: controller.scope,
            id: document.id,
            thread_id: turn.thread_id,
            turn_id: turn.id,
            citation: { source: 'note', id: document.id, revision: 1 },
          }),
        ).rejects.toMatchObject({ code: 'citation_not_found' });
        restart();
        await watch(turn);
        expect(controller.snapshot().chat_generation).toMatchObject({
          last_event_id: cursor,
          preview: text,
        });
        expect(
          readFileSync(join(directory, 'notes.sqlite')).includes(
            Buffer.from(text),
          ),
        ).toBe(false);
        release();
        await work;
        await vi.waitFor(
          async () => {
            const view = await controller.chat.read(
              readCommand(document.id, false),
            );
            expect(view.turns[0]?.result?.answer.answer.text).toContain('Mira');
            expect(controller.snapshot().chat_generation).toBeNull();
          },
          { timeout: 10_000 },
        );
        expect(
          local.getArtifact(
            controller.profile,
            document.id,
            eventArtifact(turn),
            z.unknown(),
          ),
        ).toBeNull();
        expect(answer).toHaveBeenCalledTimes(1);
        expect((await db.document(actor.user_id, document.id)).notes).toBe(
          document.notes,
        );
      } finally {
        release();
        await work;
      }
    }, 30_000);
    it('restores an expired cursor with the coherent current preview and clears both when cancellation fences a late provider reply', async () => {
      const document = await connect(),
        turn = await controller.chat.start(command(document.id));
      const complete = answer.getMockImplementation();
      if (!complete)
        throw new Error('Missing synthetic answer implementation.');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      answer.mockImplementationOnce(async (...args) => {
        if (!args[3]) throw new Error('Missing chat preview reporter.');
        await args[3]('Preview after replay retention expired.');
        await gate;
        return complete(...args);
      });
      const work = runOnce(db, providers());
      try {
        await vi.waitFor(async () =>
          expect(
            (await db.chat.eventState(actor.user_id, turn.id)).preview?.text,
          ).toBe('Preview after replay retention expired.'),
        );
        const snapshot = await db.chat.eventState(actor.user_id, turn.id);
        await db.pool.query('DELETE FROM chat_events WHERE turn_id=$1', [
          turn.id,
        ]);
        await watch(turn);
        await vi.waitFor(
          () =>
            expect(controller.snapshot().chat_generation).toMatchObject({
              last_event_id: snapshot.turn.last_event_id,
              preview: snapshot.preview!.text,
            }),
          { timeout: 10_000 },
        );
        await controller.chat.control(control(turn, 'cancel'));
        expect(controller.snapshot().chat_generation).toBeNull();
        expect(
          local.getArtifact(
            controller.profile,
            document.id,
            eventArtifact(turn),
            z.unknown(),
          ),
        ).toBeNull();
        release();
        await work;
        expect((await db.chat.get(actor.user_id, turn.id)).state).toBe(
          'cancelled',
        );
        expect(
          (await controller.chat.read(readCommand(document.id, false))).turns[0]
            ?.result,
        ).toBeNull();
        expect(answer).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await work;
      }
    }, 30_000);
    it('does not recache a held initial progress snapshot after acknowledged conversation deletion', async () => {
      const document = await connect(),
        turn = await controller.chat.start(command(document.id));
      const original = globalThis.fetch;
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).endsWith(`/chat-turns/${turn.id}/event-state`)) {
          reached();
          await gate;
        }
        return response;
      });
      const starting = watch(turn);
      const denied = expect(starting).rejects.toMatchObject({
        code: 'request_cancelled',
      });
      try {
        await ready;
        await controller.chat.remove(removeCommand(turn));
        release();
        await denied;
        expect(controller.snapshot().chat_generation).toBeNull();
        expect(
          local.getArtifact(
            controller.profile,
            document.id,
            eventArtifact(turn),
            z.unknown(),
          ),
        ).toBeNull();
        expect(
          local.getArtifact(
            controller.profile,
            document.id,
            `chat-thread:${turn.thread_id}:turn:${turn.id}`,
            z.unknown(),
          ),
        ).toBeNull();
      } finally {
        release();
        await denied;
      }
    });
    it('purges unfinished encrypted progress after live membership revocation without redispatching the held provider call', async () => {
      const document = await connect(),
        turn = await controller.chat.start(command(document.id));
      const profile = controller.profile,
        complete = answer.getMockImplementation();
      if (!complete)
        throw new Error('Missing synthetic answer implementation.');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      answer.mockImplementationOnce(async (...args) => {
        if (!args[3]) throw new Error('Missing chat preview reporter.');
        await args[3]('Private unfinished progress before revocation.');
        await gate;
        return complete(...args);
      });
      await watch(turn);
      const work = runOnce(db, providers());
      try {
        await vi.waitFor(
          () =>
            expect(controller.snapshot().chat_generation?.preview).toBe(
              'Private unfinished progress before revocation.',
            ),
          { timeout: 10_000 },
        );
        await db.pool.query(
          'UPDATE memberships SET active=false WHERE user_id=$1',
          [actor.user_id],
        );
        await vi.waitFor(
          () => expect(controller.snapshot().documents).toEqual([]),
          { timeout: 10_000 },
        );
        expect(controller.snapshot().chat_generation).toBeNull();
        expect(
          local.getArtifact(
            profile,
            document.id,
            eventArtifact(turn),
            z.unknown(),
          ),
        ).toBeNull();
        expect(
          local.getArtifact(
            profile,
            document.id,
            `chat-thread:${turn.thread_id}:turn:${turn.id}`,
            z.unknown(),
          ),
        ).toBeNull();
        expect(answer).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await work;
      }
    }, 30_000);
    it('does not tombstone a real conversation when an unknown turn is requested, or start updates for an uncached turn', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id)));
      const missing = randomUUID();
      await expect(
        controller.chat.watch({
          operation: 'watchChat',
          scope: controller.scope,
          id: document.id,
          thread_id: turn.thread_id,
          turn_id: missing,
          action: 'start',
        }),
      ).rejects.toMatchObject({ code: 'chat_turn_unavailable' });
      await expect(
        controller.chat.source({
          ...sourceCommand(turn),
          turn_id: missing,
        }),
      ).rejects.toMatchObject({ code: 'chat_not_found' });
      expect(
        (await controller.chat.read(readCommand(document.id, false))).turns[0]
          ?.id,
      ).toBe(turn.id);
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          `chat-deleted:${turn.thread_id}`,
          z.unknown(),
        ),
      ).toBeNull();
      expect((await controller.chat.source(sourceCommand(turn))).turn_id).toBe(
        turn.id,
      );
    });
    it('submits a distinct chat turn without summary jobs, preserves human notes, and freezes contextual Chinese follow-ups', async () => {
      const document = await connect();
      await controller.chat.read(readCommand(document.id));
      const first = await controller.chat.start(command(document.id));
      expect(
        desktopResponseSchema.parse({
          ok: true,
          chat_view: {
            scope: controller.scope,
            view: await controller.chat.read(readCommand(document.id, false)),
          },
        }),
      ).toHaveProperty('ok', true);
      const completed = await finish(first);
      const next = await controller.chat.start({
        ...command(document.id),
        thread_id: first.thread_id,
        question: '那截止日期呢？',
        language: 'zh',
      });
      await finish(next);
      expect(answer.mock.calls[1]![0].context?.turns).toEqual([
        {
          question: first.request.question,
          answer: completed.result!.answer.answer.text,
        },
      ]);
      expect(questionPromptVersion(answer.mock.calls[1]![0])).toBe(
        'meeting-question-context-answer-v1',
      );
      expect(
        (await controller.chat.read(readCommand(document.id))).turns,
      ).toHaveLength(2);
      expect(controller.snapshot().jobs).toEqual([]);
      expect((await db.document(actor.user_id, document.id)).notes).toBe(
        document.notes,
      );
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        settled_requests: '2',
        uncertain_requests: '0',
      });
    });
    it('saves a private exact consent body/key before dispatch and recovers an accepted receipt after edits and real store restart', async () => {
      const document = await connect(),
        request = command(document.id),
        profile = controller.profile;
      const original = globalThis.fetch,
        submissions: { key: string | null; body: unknown }[] = [];
      let lose = true;
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const submission = String(args[0]).endsWith('/chat-turns');
        if (submission) {
          const value = {
            key: new Headers(args[1]?.headers).get('idempotency-key'),
            body: JSON.parse(String(args[1]?.body)),
          };
          expect(
            local.getArtifact(
              profile,
              document.id,
              'chat-submission',
              chatIntentSchema,
            ),
          ).toMatchObject(value);
          submissions.push(value);
        }
        const response = await original(...args);
        if (submission && lose) {
          lose = false;
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost acceptance reply.');
        }
        return response;
      });
      await expect(controller.chat.start(request)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(
        (await db.chat.threads(actor.user_id, document.id, 0)).threads,
      ).toHaveLength(1);
      expect(
        JSON.stringify(
          await controller.chat.read(readCommand(document.id, false)),
        ),
      ).not.toContain(submissions[0]!.key);
      await expect(
        controller.chat.start({ ...request, consent_id: randomUUID() }),
      ).rejects.toMatchObject({ code: 'chat_request_unresolved' });
      const draft = local.get(profile, document.id);
      local.save(
        profile,
        document.id,
        draft.local_revision,
        fields('Human edits after the unknown receipt.'),
      );
      restart();
      await expect(
        controller.chat.start({
          ...request,
          scope: controller.scope,
          language: 'zh',
          new_attempt: false,
        }),
      ).rejects.toMatchObject({ code: 'chat_intent_frozen' });
      const turn = await controller.chat.start({
        ...request,
        scope: controller.scope,
        new_attempt: false,
      });
      expect(turn.request.note_revision).toBe(1);
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual(submissions[0]);
      expect(
        (await db.chat.threads(actor.user_id, document.id, 0)).threads,
      ).toHaveLength(1);
      await expect(
        controller.chat.start(command(document.id)),
      ).rejects.toMatchObject({ code: 'chat_turn_pending' });
      expect(answer).not.toHaveBeenCalled();
      local.close();
      expect(
        readFileSync(join(directory, 'notes.sqlite')).includes(
          Buffer.from(request.question),
        ),
      ).toBe(false);
      local = new LocalStore(join(directory, 'notes.sqlite'), key);
    });
    it('negotiates capability and explicit consent before persisting a question or contacting the paid queue', async () => {
      const document = await connect(),
        original = globalThis.fetch;
      expect(
        desktopCommandSchema.safeParse({
          ...command(document.id),
          confirmed: false,
        }).success,
      ).toBe(false);
      expect(
        desktopCommandSchema.safeParse({
          ...command(document.id),
          evidence: [],
        }).success,
      ).toBe(false);
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) =>
        String(args[0]).endsWith('/chat-capabilities')
          ? new Response(
              JSON.stringify({
                questions: 'durable-questions-v99',
                max_attempts: 3,
                max_pending_work: 8,
                history_context: 'meeting-question-context-v1',
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : original(...args),
      );
      await expect(
        controller.chat.start(command(document.id)),
      ).rejects.toMatchObject({ code: 'unsupported_chat_version' });
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          'chat-submission',
          chatIntentSchema,
        ),
      ).toBeNull();
      expect(
        (await db.chat.threads(actor.user_id, document.id, 0)).threads,
      ).toEqual([]);
    });
    it('surfaces definitive input rejection and requires a new explicit consent instead of silently rebuilding revisions', async () => {
      const document = await connect(),
        original = globalThis.fetch,
        request = command(document.id);
      let change = true;
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]).endsWith('/chat-turns') && change) {
          change = false;
          await db.edit(
            actor.user_id,
            document.id,
            1,
            { notes: 'Newer evidence.' },
            randomUUID(),
          );
        }
        return original(...args);
      });
      await expect(controller.chat.start(request)).rejects.toMatchObject({
        code: 'revision_conflict',
      });
      expect(
        (await controller.chat.read(readCommand(document.id, false))).submission
          ?.rejected,
      ).toBe(true);
      await expect(
        controller.chat.start({ ...request, new_attempt: false }),
      ).rejects.toMatchObject({ code: 'chat_request_rejected' });
      const turn = await controller.chat.start(command(document.id));
      expect(turn.request.note_revision).toBe(2);
    });
    it('persists the original recovery token across restart and never authorizes a later token with a lost earlier receipt', async () => {
      const document = await connect(),
        first = await controller.chat.start(command(document.id));
      const failed = await fail(first),
        original = globalThis.fetch,
        request = control(failed, 'resume');
      let lose = true;
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/resume') && lose) {
          lose = false;
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost resume reply.');
        }
        return response;
      });
      await expect(controller.chat.control(request)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      const second = await fail(first);
      expect(second.resume_token).not.toBe(failed.resume_token);
      restart();
      expect(
        (await controller.chat.read(readCommand(document.id, false))).recovery
          ?.resume_token,
      ).toBe(failed.resume_token);
      await expect(
        controller.chat.control({
          ...control(second, 'resume'),
          scope: controller.scope,
        }),
      ).rejects.toMatchObject({ code: 'chat_recovery_unresolved' });
      const reconciled = await controller.chat.control({
        ...request,
        scope: controller.scope,
      });
      expect(reconciled.state).toBe('failed');
      expect(reconciled.resume_token).toBe(second.resume_token);
      expect(await db.chat.claim()).toBeNull();
      await controller.chat.control(control(second, 'resume'));
      await finish(first);
      expect(answer).toHaveBeenCalledTimes(3);
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        uncertain_requests: '2',
        settled_requests: '1',
      });
    });
    it('cancels an unconfirmed recovery without sending it merely to reconcile its lost receipt', async () => {
      const first = await controller.chat.start(command((await connect()).id)),
        failed = await fail(first),
        original = globalThis.fetch;
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]).endsWith('/resume'))
          throw new TypeError('Synthetic request never reached the service.');
        return original(...args);
      });
      await expect(
        controller.chat.control(control(failed, 'resume')),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(
        (await controller.chat.read(readCommand(first.document_id, false)))
          .recovery,
      ).not.toBeNull();
      expect(
        (await controller.chat.control(control(failed, 'cancel'))).state,
      ).toBe('cancelled');
      expect(
        (await controller.chat.read(readCommand(first.document_id, false)))
          .recovery,
      ).toBeNull();
      expect(await db.chat.claim()).toBeNull();
      await expect(
        db.chat.resume(actor.user_id, first.id, failed.resume_token!),
      ).rejects.toMatchObject({ code: 'question_not_resumable' });
      expect(answer).toHaveBeenCalledTimes(1);
    });
    it('rejects a stale initial recovery token before saving recovery consent or dispatching a resume request', async () => {
      const turn = await fail(
        await controller.chat.start(command((await connect()).id)),
      );
      await expect(
        controller.chat.control({
          ...control(turn, 'resume'),
          resume_token: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'chat_resume_changed' });
      expect(
        local.getArtifact(
          controller.profile,
          turn.document_id,
          'chat-recovery',
          chatRecoveryViewSchema,
        ),
      ).toBeNull();
      expect(await db.chat.claim()).toBeNull();
    });
    it('keeps frozen cited sources and completed history encrypted across edits, offline reads and restart without appending AI text to notes', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id)));
      const source = await controller.chat.source(sourceCommand(turn));
      expect(source.excerpts[0]?.text).toBe(document.notes);
      await db.edit(
        actor.user_id,
        document.id,
        1,
        { notes: 'Later human notes.' },
        randomUUID(),
      );
      await controller.synchronize();
      restart();
      const original = globalThis.fetch;
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('Synthetic offline state.');
      });
      const view = await controller.chat.read(readCommand(document.id, false));
      expect(view.cached).toBe(true);
      expect(view.turns[0]?.result).toEqual(turn.result);
      expect(await controller.chat.source(sourceCommand(turn))).toEqual(source);
      expect(local.get(controller.profile, document.id).content).toEqual(
        richTextFromPlainText('Later human notes.'),
      );
      vi.stubGlobal('fetch', original);
      expect(
        (await controller.chat.read(readCommand(document.id))).turns[0]
          ?.input_stale,
      ).toBe(true);
      expect(
        desktopResponseSchema.parse({
          ok: true,
          chat_source: { scope: controller.scope, source },
        }),
      ).toHaveProperty('ok', true);
    });
    it('never treats prior completed history as evidence for an empty current meeting', async () => {
      const document = await connect(),
        first = await finish(await controller.chat.start(command(document.id)));
      await db.edit(actor.user_id, document.id, 1, { notes: '' }, randomUUID());
      const next = await controller.chat.start({
        ...command(document.id),
        thread_id: first.thread_id,
      });
      const result = await finish(next);
      expect(result.result?.answer.status).toBe('insufficient_evidence');
      expect(result.provider_requests).toBe(0);
      expect(answer).toHaveBeenCalledTimes(1);
    });
    it('scrubs conversation content before deleting, persists a lost delete receipt across restart, and never recreates deleted contents', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id)));
      await controller.chat.source(sourceCommand(turn));
      const original = globalThis.fetch;
      let lose = true;
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (
          args[1]?.method === 'DELETE' &&
          String(args[0]).includes('/chat-threads/') &&
          lose
        ) {
          lose = false;
          await response.arrayBuffer();
          throw new TypeError('Synthetic lost delete reply.');
        }
        return response;
      });
      await expect(
        controller.chat.remove(removeCommand(turn)),
      ).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(
        await controller.chat.read(readCommand(document.id, false)),
      ).toMatchObject({
        thread_id: null,
        turns: [],
        deleting_thread_id: turn.thread_id,
        submission: null,
      });
      await expect(
        controller.chat.source(sourceCommand(turn)),
      ).rejects.toMatchObject({ code: 'chat_deletion_pending' });
      restart();
      await controller.chat.remove(removeCommand(turn));
      expect(
        (await controller.chat.read(readCommand(document.id, false)))
          .deleting_thread_id,
      ).toBeNull();
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          `chat-thread:${turn.thread_id}:turn:${turn.id}`,
          z.unknown(),
        ),
      ).toBeNull();
      await expect(
        controller.chat.start({ ...command(document.id), new_attempt: false }),
      ).rejects.toMatchObject({ code: 'chat_request_missing' });
      expect(
        (await db.chat.threads(actor.user_id, document.id, 0)).threads,
      ).toEqual([]);
      expect(await db.usage.snapshot(actor.user_id)).toMatchObject({
        settled_requests: '1',
      });
    });
    it('fences a late directory snapshot after acknowledged deletion with a durable body-free local tombstone', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id))),
        original = globalThis.fetch;
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/chat-threads?offset=0')) {
          reached();
          await gate;
        }
        return response;
      });
      const read = controller.chat.read(readCommand(document.id));
      await ready;
      await controller.chat.remove(removeCommand(turn));
      release();
      expect(await read).toMatchObject({
        threads: [],
        turns: [],
        thread_id: null,
      });
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          `chat-thread:${turn.thread_id}:meta`,
          z.unknown(),
        ),
      ).toBeNull();
      expect(
        JSON.stringify(
          local.getArtifact(
            controller.profile,
            document.id,
            'chat-directory',
            z.unknown(),
          ),
        ),
      ).not.toContain(turn.request.question);
    });
    it('clears local frozen sources after discovering another client deleted the conversation', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id)));
      await controller.chat.source(sourceCommand(turn));
      await db.chat.remove(actor.user_id, turn.thread_id);
      await expect(
        controller.chat.read(readCommand(document.id)),
      ).rejects.toMatchObject({ code: 'chat_not_found' });
      expect(
        (await controller.chat.read(readCommand(document.id, false))).turns,
      ).toEqual([]);
      expect(
        local.getArtifact(
          controller.profile,
          document.id,
          `chat-thread:${turn.thread_id}:source:${turn.id}:${citationKey(sourceCommand(turn).citation)}`,
          chatSourceSchema,
        ),
      ).toBeNull();
    });
    it('rejects another document or duplicate history sequence before replacing the encrypted saved page', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id))),
        original = globalThis.fetch;
      for (const rows of [
        [{ ...turn, document_id: randomUUID() }],
        [turn, turn],
      ]) {
        vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) =>
          String(args[0]).includes('/turns?after=')
            ? new Response(JSON.stringify({ turns: rows, has_more: false }), {
                headers: { 'content-type': 'application/json' },
              })
            : original(...args),
        );
        await expect(
          controller.chat.read(readCommand(document.id)),
        ).rejects.toMatchObject({ code: 'invalid_server_response' });
        expect(
          (await controller.chat.read(readCommand(document.id, false))).turns,
        ).toEqual([turn]);
      }
    });
    it('fails closed on a mismatched or uncited source and never caches it', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id))),
        original = globalThis.fetch;
      await expect(
        controller.chat.source({
          ...sourceCommand(turn),
          citation: { source: 'note', id: randomUUID(), revision: 1 },
        }),
      ).rejects.toMatchObject({ code: 'citation_not_found' });
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (!String(args[0]).endsWith('/citation')) return response;
        const source = chatSourceSchema.parse(await response.json());
        return new Response(
          JSON.stringify({ ...source, turn_id: randomUUID() }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      await expect(
        controller.chat.source(sourceCommand(turn)),
      ).rejects.toMatchObject({ code: 'invalid_server_response' });
    });
    it('does not cache an accepted response delivered after the user leaves the workspace', async () => {
      const document = await connect(),
        request = command(document.id),
        profile = controller.profile,
        original = globalThis.fetch;
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/chat-turns')) {
          reached();
          await gate;
        }
        return response;
      });
      const submission = controller.chat.start(request);
      await ready;
      await controller.execute({
        operation: 'workOffline',
        scope: controller.scope,
      });
      release();
      await expect(submission).rejects.toMatchObject({
        code: 'request_cancelled',
      });
      expect(
        local.getArtifact(
          profile,
          document.id,
          'chat-submission',
          chatIntentSchema,
        )?.turn_id,
      ).toBeNull();
      expect(
        (await db.chat.threads(actor.user_id, document.id, 0)).threads,
      ).toHaveLength(1);
    });
    it('purges cached private chat after provisioned membership revocation instead of falling back to a saved answer', async () => {
      const document = await connect(),
        turn = await finish(await controller.chat.start(command(document.id))),
        profile = controller.profile;
      await controller.chat.source(sourceCommand(turn));
      await db.pool.query(
        'UPDATE memberships SET active=false WHERE user_id=$1',
        [actor.user_id],
      );
      await expect(
        controller.chat.read(readCommand(document.id)),
      ).rejects.toThrow();
      expect(controller.snapshot().documents).toEqual([]);
      expect(
        local.getArtifact(
          profile,
          document.id,
          `chat-thread:${turn.thread_id}:turn:${turn.id}`,
          z.unknown(),
        ),
      ).toBeNull();
      await expect(
        controller.chat.source(sourceCommand(turn)),
      ).rejects.toThrow();
    });
    it('paginates more than fifty questions without crossing meetings and keeps visited pages available offline', async () => {
      const document = await connect(),
        first = await finish(await controller.chat.start(command(document.id)));
      for (let index = 1; index < 52; index++) {
        await db.chat.enqueue(
          actor.user_id,
          document.id,
          {
            ...first.request,
            thread_id: first.thread_id,
            question: `Synthetic question ${index}?`,
          },
          `history:${randomUUID()}`,
        );
        await runOnce(db, providers());
      }
      const latest = await controller.chat.read(readCommand(document.id));
      expect(latest.after).toBe(50);
      expect(latest.turns.map((turn) => turn.position)).toEqual([51, 52]);
      const earlier = await controller.chat.read({
        ...readCommand(document.id),
        after: 0,
      });
      expect(earlier.turns).toHaveLength(50);
      expect(earlier.turns_has_more).toBe(true);
      const original = globalThis.fetch;
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('Synthetic offline state.');
      });
      expect(
        (
          await controller.chat.read({
            ...readCommand(document.id, false),
            after: 0,
          })
        ).turns,
      ).toHaveLength(50);
      expect(
        (
          await controller.chat.read({
            ...readCommand(document.id, false),
            after: 50,
          })
        ).turns,
      ).toHaveLength(2);
      vi.stubGlobal('fetch', original);
      expect(
        chatTurnPageSchema.parse(
          await db.chat.history(actor.user_id, first.thread_id, 50),
        ).turns,
      ).toHaveLength(2);
    }, 30_000);
  },
);
