import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStore } from '@windows-ai-notes/local';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  citationKey,
  idempotencyKey,
  resourceId,
} from '@windows-ai-notes/contracts/server';
import type { DesktopCommand } from '@windows-ai-notes/contracts/desktop';
import {
  CHAT_VERSION,
  chatCapabilitiesSchema,
  chatSubmissionSchema,
  chatThreadSchema,
  chatThreadPageSchema,
  chatTurnSchema,
  chatTurnPageSchema,
  chatSourceSchema,
  chatRecoveryViewSchema,
  chatViewSchema,
  type ChatTurn,
} from '@windows-ai-notes/contracts/questions';
import { ApiClient, ClientError } from './http.js';
import { ChatEvents } from './chat-events.js';

export const chatIntentSchema = z
  .strictObject({
    body: chatSubmissionSchema,
    key: idempotencyKey,
    consent_id: resourceId,
    turn_id: resourceId.nullable(),
    thread_id: resourceId.nullable(),
    rejected: z.boolean().default(false),
  })
  .refine(
    (value) =>
      (value.turn_id === null || value.thread_id !== null) &&
      (!value.body.thread_id || value.body.thread_id === value.thread_id) &&
      (!value.rejected || value.turn_id === null),
  );
const directorySchema = chatThreadPageSchema.extend({
  offset: z.number().int().nonnegative(),
});
const pageSchema = chatTurnPageSchema.extend({ complete: z.boolean() });
const deletionSchema = z.strictObject({ thread_id: resourceId });
type Command<Name extends DesktopCommand['operation']> = Extract<
  DesktopCommand,
  { operation: Name }
>;
type Owner = {
  profile: string;
  authorize: () => void;
  remote: { api: ApiClient; authorize: () => void } | null;
};
type Hooks = {
  owner: (scope: number) => Owner;
  synchronize: () => Promise<void>;
  changed: () => void;
  revoked: (error: unknown, profile: string, api: ApiClient) => void;
  reads: Set<AbortController>;
};
const problem = (code: string, message: string) =>
  new ClientError(code, message);
const prefix = (thread: string) => `chat-thread:${thread}:`;
const pageAfter = (position: number) => Math.floor((position - 1) / 50) * 50;
const active = (turn: ChatTurn) => ['queued', 'running'].includes(turn.state);
function bound(turn: ChatTurn, document: string, thread?: string, id?: string) {
  if (
    turn.document_id !== document ||
    (turn.request.thread_id && turn.request.thread_id !== turn.thread_id) ||
    (thread && turn.thread_id !== thread) ||
    (id && turn.id !== id)
  )
    throw problem(
      'invalid_server_response',
      'The service returned another meeting, conversation or question.',
    );
  return turn;
}

export class DesktopChat {
  readonly events: ChatEvents;
  private readonly writes = new Set<string>();
  constructor(
    private readonly local: LocalStore,
    private readonly hooks: Hooks,
  ) {
    this.events = new ChatEvents(local, {
      owner: (scope, id, thread) => {
        const owner = this.owner(scope, id),
          remote = owner.remote;
        if (!remote)
          throw problem(
            'workspace_not_connected',
            'Reconnect the original workspace for question updates.',
          );
        const authorize = () => {
          owner.authorize();
          remote.authorize();
          this.local.get(owner.profile, id);
          this.available(owner.profile, id, thread);
        };
        authorize();
        return { profile: owner.profile, api: remote.api, authorize };
      },
      reads: hooks.reads,
      changed: hooks.changed,
      cache: (profile, id, turn) => this.latest(profile, id, turn, false),
      failed: (error, owner, id, thread, signal) =>
        this.failure(error, owner, id, signal, thread),
    });
  }
  private owner(scope: number, id: string) {
    const owner = this.hooks.owner(scope);
    this.local.get(owner.profile, id);
    owner.authorize();
    return owner;
  }
  private deleting(profile: string, id: string) {
    return this.local.getArtifact(profile, id, 'chat-deletion', deletionSchema);
  }
  private removed(profile: string, id: string, thread: string) {
    return (
      this.local.getArtifact(
        profile,
        id,
        `chat-deleted:${thread}`,
        z.literal(true),
      ) === true
    );
  }
  private available(profile: string, id: string, thread: string) {
    if (
      this.removed(profile, id, thread) ||
      this.deleting(profile, id)?.thread_id === thread
    )
      throw problem(
        'chat_deletion_pending',
        'This conversation is being deleted. Confirm its removal before reading or changing it.',
      );
    const meta = this.local.getArtifact(
      profile,
      id,
      `${prefix(thread)}meta`,
      chatThreadSchema,
    );
    if (!meta || meta.document_id !== id || meta.id !== thread)
      throw problem(
        'chat_thread_unavailable',
        'Refresh the conversation list before opening this conversation.',
      );
    return meta;
  }
  private forget(profile: string, id: string, thread: string) {
    // Fence reads already in flight without retaining deleted conversation text.
    this.local.putArtifact(profile, id, `chat-deleted:${thread}`, true);
    this.events.stopThread(profile, id, thread);
    this.local.deleteArtifactPrefix(profile, id, prefix(thread));
    const directory = this.local.getArtifact(
      profile,
      id,
      'chat-directory',
      directorySchema,
    );
    if (directory)
      this.local.putArtifact(profile, id, 'chat-directory', {
        ...directory,
        threads: directory.threads.filter((item) => item.id !== thread),
      });
    const intent = this.local.getArtifact(
      profile,
      id,
      'chat-submission',
      chatIntentSchema,
    );
    if (intent?.thread_id === thread)
      this.local.deleteArtifact(profile, id, 'chat-submission');
    const recovery = this.local.getArtifact(
      profile,
      id,
      'chat-recovery',
      chatRecoveryViewSchema,
    );
    if (recovery?.thread_id === thread)
      this.local.deleteArtifact(profile, id, 'chat-recovery');
    const selection = this.local.getArtifact(
      profile,
      id,
      'chat-selection',
      resourceId,
    );
    if (selection === thread)
      this.local.deleteArtifact(profile, id, 'chat-selection');
  }
  private async remote<T>(
    scope: number,
    id: string,
    run: (owner: Owner & { api: ApiClient }, signal: AbortSignal) => Promise<T>,
    thread?: string,
  ) {
    const owner = this.owner(scope, id),
      remote = owner.remote;
    if (!remote)
      throw problem(
        'workspace_not_connected',
        'Reconnect the original workspace for this chat operation.',
      );
    if (this.hooks.reads.size >= 4)
      throw problem(
        'request_busy',
        'Wait for the current account or meeting requests to finish.',
      );
    const read = new AbortController();
    this.hooks.reads.add(read);
    const authorize = () => {
      owner.authorize();
      remote.authorize();
      read.signal.throwIfAborted();
      this.local.get(owner.profile, id);
    };
    try {
      authorize();
      const result = await run(
        { ...owner, api: remote.api, authorize },
        read.signal,
      );
      authorize();
      return result;
    } catch (error) {
      throw await this.failure(
        error,
        { profile: owner.profile, api: remote.api, authorize },
        id,
        read.signal,
        thread,
      );
    } finally {
      this.hooks.reads.delete(read);
    }
  }
  private async failure(
    error: unknown,
    owner: { profile: string; api: ApiClient; authorize: () => void },
    id: string,
    signal: AbortSignal,
    thread?: string,
  ) {
    let failure = error;
    if (
      error instanceof ClientError &&
      ['chat_not_found', 'document_not_found'].includes(error.code)
    ) {
      owner.authorize();
      try {
        if (error.code === 'chat_not_found') {
          const target =
            thread ??
            this.local.getArtifact(
              owner.profile,
              id,
              'chat-submission',
              chatIntentSchema,
            )?.thread_id;
          if (target) {
            try {
              const page = await owner.api.request(
                `/v1/chat-threads/${target}/turns?after=0`,
                chatTurnPageSchema,
                { signal },
              );
              owner.authorize();
              for (const turn of page.turns) bound(turn, id, target);
            } catch (threadError) {
              if (
                !(threadError instanceof ClientError) ||
                threadError.code !== 'chat_not_found'
              )
                throw threadError;
              const document = await owner.api.document(id, signal);
              owner.authorize();
              if (document.id !== id)
                throw problem(
                  'invalid_server_response',
                  'The service returned another meeting.',
                );
              this.local.atomic(() => {
                this.forget(owner.profile, id, target);
              });
              this.hooks.changed();
              return error;
            }
          }
        }
      } catch (accessError) {
        failure = accessError;
      }
      // A hidden document 404 can mean revoked membership, not conversation deletion.
      try {
        owner.authorize();
        await this.hooks.synchronize();
        owner.authorize();
      } catch (accessError) {
        failure = accessError;
      }
    }
    this.hooks.revoked(failure, owner.profile, owner.api);
    return failure;
  }
  async watch(command: Command<'watchChat'>) {
    const owner = this.owner(command.scope, command.id);
    if (command.action === 'start') {
      const turn = this.local.getArtifact(
        owner.profile,
        command.id,
        `${prefix(command.thread_id)}turn:${command.turn_id}`,
        chatTurnSchema,
      );
      if (!turn)
        throw problem(
          'chat_turn_unavailable',
          'Load this question before connecting its updates.',
        );
      bound(turn, command.id, command.thread_id, command.turn_id);
      await this.events.start(
        command.scope,
        command.id,
        command.thread_id,
        command.turn_id,
      );
    } else {
      this.events.stop(command.turn_id);
      owner.authorize();
      this.hooks.changed();
    }
  }
  private async write<T>(scope: number, id: string, run: () => Promise<T>) {
    const owner = this.owner(scope, id),
      mutex = `${owner.profile}:${id}`;
    if (this.writes.has(mutex))
      throw problem(
        'chat_busy',
        'Wait for the current conversation change to finish.',
      );
    this.writes.add(mutex);
    try {
      return await run();
    } finally {
      this.writes.delete(mutex);
    }
  }
  private remember(profile: string, id: string, value: ChatTurn) {
    bound(value, id);
    if (
      this.removed(profile, id, value.thread_id) ||
      this.deleting(profile, id)?.thread_id === value.thread_id
    )
      throw problem(
        'chat_deletion_pending',
        'Deleted conversation output was not saved.',
      );
    const name = `${prefix(value.thread_id)}turn:${value.id}`;
    const previous = this.local.getArtifact(profile, id, name, chatTurnSchema);
    if (
      previous &&
      (previous.position !== value.position ||
        previous.mode !== value.mode ||
        canonicalJson(previous.request) !== canonicalJson(value.request))
    )
      throw problem(
        'invalid_server_response',
        'The service changed an immutable saved question.',
      );
    if (
      previous?.result &&
      previous.last_event_id <= value.last_event_id &&
      canonicalJson(previous.result) !== canonicalJson(value.result)
    )
      throw problem(
        'invalid_server_response',
        'The service changed a completed saved answer.',
      );
    const turn =
      previous && previous.last_event_id > value.last_event_id
        ? previous
        : value;
    this.local.putArtifact(profile, id, name, turn);
    this.events.settled(profile, id, turn);
    const metaName = `${prefix(turn.thread_id)}meta`;
    const meta = this.local.getArtifact(
      profile,
      id,
      metaName,
      chatThreadSchema,
    );
    this.local.putArtifact(profile, id, metaName, {
      id: turn.thread_id,
      document_id: id,
      title: meta?.title ?? turn.request.question.trim().slice(0, 200),
      last_position: Math.max(meta?.last_position ?? 0, turn.position),
      created_at: meta?.created_at ?? turn.created_at,
    });
    return turn;
  }
  private latest(profile: string, id: string, turn: ChatTurn, select = true) {
    let value = turn;
    this.local.atomic(() => {
      value = this.remember(profile, id, turn);
      const after = pageAfter(value.position),
        name = `${prefix(value.thread_id)}page:${after}`;
      const previous = this.local.getArtifact(profile, id, name, pageSchema);
      const turns = [
        ...(previous?.turns ?? []).filter((item) => item.id !== value.id),
        value,
      ].sort((a, b) => a.position - b.position);
      const meta = this.available(profile, id, value.thread_id);
      const complete =
        turns.length ===
          Math.min(50, Math.max(0, meta.last_position - after)) &&
        turns.every((item, index) => item.position === after + index + 1);
      this.local.putArtifact(profile, id, name, {
        turns,
        has_more: meta.last_position > after + 50,
        complete,
      });
      if (select)
        this.local.putArtifact(profile, id, 'chat-selection', value.thread_id);
      const directory = this.local.getArtifact(
        profile,
        id,
        'chat-directory',
        directorySchema,
      );
      if (directory?.offset === 0) {
        const threads = directory.threads.filter(
          (thread) => thread.id !== value.thread_id,
        );
        if (
          threads.length !== directory.threads.length ||
          value.position === 1
        ) {
          threads.push(meta);
          threads.sort(
            (a, b) =>
              b.created_at.localeCompare(a.created_at) ||
              b.id.localeCompare(a.id),
          );
          this.local.putArtifact(profile, id, 'chat-directory', {
            ...directory,
            threads: threads.slice(0, 50),
            has_more: directory.has_more || threads.length > 50,
          });
        }
      }
    });
    return value;
  }
  async read(command: Command<'getChat'>) {
    const owner = this.owner(command.scope, command.id);
    if (command.refresh)
      await this.remote(command.scope, command.id, async (context, signal) => {
        const response = await context.api.request(
          `/v1/documents/${command.id}/chat-threads?offset=${command.offset}`,
          chatThreadPageSchema,
          { signal },
        );
        context.authorize();
        if (
          response.threads.some((item) => item.document_id !== command.id) ||
          new Set(response.threads.map((item) => item.id)).size !==
            response.threads.length
        )
          throw problem(
            'invalid_server_response',
            'The service returned an invalid conversation list.',
          );
        this.local.atomic(() => {
          const threads = response.threads.filter(
            (thread) =>
              !this.removed(context.profile, command.id, thread.id) &&
              this.deleting(context.profile, command.id)?.thread_id !==
                thread.id,
          );
          for (const thread of threads) {
            const name = `${prefix(thread.id)}meta`,
              old = this.local.getArtifact(
                context.profile,
                command.id,
                name,
                chatThreadSchema,
              );
            this.local.putArtifact(context.profile, command.id, name, {
              ...thread,
              last_position: Math.max(
                thread.last_position,
                old?.last_position ?? 0,
              ),
            });
          }
          this.local.putArtifact(
            context.profile,
            command.id,
            'chat-directory',
            { ...response, threads, offset: command.offset },
          );
        });
      });
    owner.authorize();
    const directory = this.local.getArtifact(
      owner.profile,
      command.id,
      'chat-directory',
      directorySchema,
    );
    const deletion = this.deleting(owner.profile, command.id);
    const threads = (
      directory?.offset === command.offset ? directory.threads : []
    ).filter(
      (thread) =>
        thread.id !== deletion?.thread_id &&
        !this.removed(owner.profile, command.id, thread.id),
    );
    const saved = this.local.getArtifact(
      owner.profile,
      command.id,
      'chat-selection',
      resourceId,
    );
    let selected =
      command.thread_id === undefined
        ? (saved ?? threads[0]?.id ?? null)
        : command.thread_id;
    if (
      selected &&
      (selected === deletion?.thread_id ||
        this.removed(owner.profile, command.id, selected))
    )
      selected = null;
    let after = command.after ?? 0;
    let page: z.infer<typeof pageSchema> | null = null;
    if (selected) {
      const thread = this.available(owner.profile, command.id, selected);
      after = command.after ?? pageAfter(thread.last_position);
      const name = `${prefix(selected)}page:${after}`;
      if (command.refresh)
        await this.remote(
          command.scope,
          command.id,
          async (context, signal) => {
            const response = await context.api.request(
              `/v1/chat-threads/${selected}/turns?after=${after}`,
              chatTurnPageSchema,
              { signal },
            );
            context.authorize();
            this.available(context.profile, command.id, selected);
            let position = after;
            for (const turn of response.turns) {
              bound(turn, command.id, selected);
              if (turn.position !== position + 1)
                throw problem(
                  'invalid_server_response',
                  'The service returned skipped, unordered or repeated questions.',
                );
              position = turn.position;
            }
            if (
              new Set(response.turns.map((turn) => turn.id)).size !==
              response.turns.length
            )
              throw problem(
                'invalid_server_response',
                'The service returned repeated questions.',
              );
            this.local.atomic(() => {
              const turns = response.turns.map((turn) =>
                this.remember(context.profile, command.id, turn),
              );
              const previous = this.local.getArtifact(
                context.profile,
                command.id,
                name,
                pageSchema,
              );
              const last = turns.at(-1)?.position ?? after;
              turns.push(
                ...(previous?.turns ?? []).filter(
                  (turn) => turn.position > last && turn.position <= after + 50,
                ),
              );
              const meta = this.available(
                context.profile,
                command.id,
                selected,
              );
              this.local.putArtifact(context.profile, command.id, name, {
                ...response,
                turns,
                has_more: response.has_more || meta.last_position > after + 50,
                complete:
                  turns.length ===
                    Math.min(50, Math.max(0, meta.last_position - after)) &&
                  turns.every(
                    (turn, index) => turn.position === after + index + 1,
                  ),
              });
            });
          },
          selected,
        );
      owner.authorize();
      this.available(owner.profile, command.id, selected);
      page = this.local.getArtifact(
        owner.profile,
        command.id,
        name,
        pageSchema,
      );
      this.local.putArtifact(
        owner.profile,
        command.id,
        'chat-selection',
        selected,
      );
    } else if (command.thread_id === null) {
      this.local.deleteArtifact(owner.profile, command.id, 'chat-selection');
    }
    const intent = this.local.getArtifact(
      owner.profile,
      command.id,
      'chat-submission',
      chatIntentSchema,
    );
    const recovery = this.local.getArtifact(
      owner.profile,
      command.id,
      'chat-recovery',
      chatRecoveryViewSchema,
    );
    return chatViewSchema.parse({
      document_id: command.id,
      offset: command.offset,
      threads,
      threads_has_more:
        directory?.offset === command.offset && directory.has_more,
      thread_id: selected,
      after,
      turns: page?.turns ?? [],
      turns_has_more: page?.has_more ?? false,
      history_complete: page?.complete ?? selected === null,
      cached: !command.refresh,
      submission: intent
        ? {
            question: intent.body.question,
            language: intent.body.language,
            consent_id: intent.consent_id,
            turn_id: intent.turn_id,
            thread_id: intent.thread_id,
            rejected: intent.rejected,
          }
        : null,
      recovery,
      deleting_thread_id: deletion?.thread_id ?? null,
    });
  }
  async start(command: Command<'askMeeting'>) {
    if (command.confirmed !== true)
      throw problem(
        'chat_consent_required',
        'Confirm Azure processing before asking a question.',
      );
    return this.write(command.scope, command.id, () =>
      this.remote(
        command.scope,
        command.id,
        async (context, signal) => {
          if (this.deleting(context.profile, command.id))
            throw problem(
              'chat_deletion_pending',
              'Finish the saved conversation deletion before asking another question.',
            );
          if (
            this.local.getArtifact(
              context.profile,
              command.id,
              'chat-recovery',
              chatRecoveryViewSchema,
            )
          )
            throw problem(
              'chat_recovery_unresolved',
              'Recover the saved recovery receipt or cancel its question before authorizing another paid request.',
            );
          let intent = this.local.getArtifact(
            context.profile,
            command.id,
            'chat-submission',
            chatIntentSchema,
          );
          if (!intent && !command.new_attempt)
            throw problem(
              'chat_request_missing',
              'There is no saved question request to recover.',
            );
          if (
            intent &&
            command.new_attempt &&
            intent.consent_id !== command.consent_id
          ) {
            if (!intent.turn_id && !intent.rejected)
              throw problem(
                'chat_request_unresolved',
                'Recover the saved question receipt before authorizing another paid request.',
              );
            if (intent.turn_id && intent.thread_id) {
              const previous = bound(
                await context.api.request(
                  `/v1/chat-turns/${intent.turn_id}`,
                  chatTurnSchema,
                  { signal },
                ),
                command.id,
                intent.thread_id,
                intent.turn_id,
              );
              context.authorize();
              this.latest(context.profile, command.id, previous);
              if (active(previous))
                throw problem(
                  'chat_turn_pending',
                  'Finish or cancel the current question before asking another.',
                );
            }
            intent = null;
          }
          if (!intent) {
            const capability = await context.api.request(
              '/v1/chat-capabilities',
              chatCapabilitiesSchema,
              { signal },
            );
            context.authorize();
            if (
              capability.questions !== CHAT_VERSION ||
              capability.max_attempts > 3 ||
              capability.history_context !== 'meeting-question-context-v1'
            )
              throw problem(
                'unsupported_chat_version',
                'The connected service does not support this desktop chat version.',
              );
            if (command.thread_id)
              this.available(context.profile, command.id, command.thread_id);
            await this.hooks.synchronize();
            context.authorize();
            const draft = this.local.get(context.profile, command.id);
            if (draft.status !== 'synced')
              throw problem(
                'chat_input_unsynced',
                'Synchronize the notes and resolve any conflict before asking a question.',
              );
            const document = await context.api.document(command.id, signal);
            context.authorize();
            const current = this.local.get(context.profile, command.id);
            if (
              document.id !== command.id ||
              current.local_revision !== draft.local_revision ||
              current.status !== 'synced' ||
              current.remote_revision !== document.revision
            )
              throw problem(
                'chat_input_changed',
                'The meeting changed during preparation. Review the latest notes before asking.',
              );
            intent = chatIntentSchema.parse({
              body: {
                note_revision: document.revision,
                transcript_revision: document.transcript_revision,
                language: command.language,
                question: command.question,
                confirmed: true,
                ...(command.thread_id ? { thread_id: command.thread_id } : {}),
              },
              key: `question:${randomUUID()}`,
              consent_id: command.consent_id,
              turn_id: null,
              thread_id: command.thread_id ?? null,
            });
            this.local.putArtifact(
              context.profile,
              command.id,
              'chat-submission',
              intent,
            );
            this.hooks.changed();
          } else if (intent.rejected)
            throw problem(
              'chat_request_rejected',
              'The saved question was rejected before acceptance. Review the meeting and explicitly authorize a new request.',
            );
          else if (
            intent.body.question !== command.question ||
            intent.body.language !== command.language ||
            intent.body.thread_id !== command.thread_id
          )
            throw problem(
              'chat_intent_frozen',
              'Recover the saved question with its original text, language and conversation.',
            );
          let turn: ChatTurn;
          try {
            turn = bound(
              intent.turn_id
                ? await context.api.request(
                    `/v1/chat-turns/${intent.turn_id}`,
                    chatTurnSchema,
                    { signal },
                  )
                : await context.api.request(
                    `/v1/documents/${command.id}/chat-turns`,
                    chatTurnSchema,
                    {
                      method: 'POST',
                      body: intent.body,
                      key: intent.key,
                      signal,
                    },
                  ),
              command.id,
              intent.body.thread_id,
              intent.turn_id ?? undefined,
            );
            if (canonicalJson(turn.request) !== canonicalJson(intent.body))
              throw problem(
                'invalid_server_response',
                'The service returned a receipt for different question input.',
              );
          } catch (error) {
            if (
              !intent.turn_id &&
              error instanceof ClientError &&
              [
                'revision_conflict',
                'chat_request_deleted',
                'chat_turn_pending',
                'chat_thread_full',
              ].includes(error.code)
            ) {
              context.authorize();
              this.local.putArtifact(
                context.profile,
                command.id,
                'chat-submission',
                { ...intent, rejected: true },
              );
              this.hooks.changed();
            }
            throw error;
          }
          context.authorize();
          this.local.atomic(() => {
            this.latest(context.profile, command.id, turn);
            this.local.putArtifact(
              context.profile,
              command.id,
              'chat-submission',
              { ...intent, turn_id: turn.id, thread_id: turn.thread_id },
            );
          });
          this.hooks.changed();
          return turn;
        },
        command.thread_id,
      ),
    );
  }
  async control(command: Command<'controlChatTurn'>) {
    if (command.confirmed !== true)
      throw problem(
        'chat_consent_required',
        'Confirm this conversation change.',
      );
    return this.write(command.scope, command.id, () =>
      this.remote(
        command.scope,
        command.id,
        async (context, signal) => {
          this.available(context.profile, command.id, command.thread_id);
          const existing = this.local.getArtifact(
            context.profile,
            command.id,
            'chat-recovery',
            chatRecoveryViewSchema,
          );
          if (
            existing &&
            (existing.thread_id !== command.thread_id ||
              existing.turn_id !== command.turn_id ||
              (command.action === 'resume' &&
                existing.resume_token !== command.resume_token))
          )
            throw problem(
              'chat_recovery_unresolved',
              'Recover the saved recovery receipt before authorizing a different conversation change.',
            );
          let turn = bound(
            await context.api.request(
              `/v1/chat-turns/${command.turn_id}`,
              chatTurnSchema,
              { signal },
            ),
            command.id,
            command.thread_id,
            command.turn_id,
          );
          context.authorize();
          this.available(context.profile, command.id, command.thread_id);
          if (command.action === 'resume') {
            if (!command.resume_token)
              throw problem(
                'chat_resume_required',
                'Refresh and explicitly confirm recovery of this question.',
              );
            if (
              !existing &&
              (!turn.resume_available ||
                turn.resume_token !== command.resume_token)
            )
              throw problem(
                'chat_resume_changed',
                'Refresh and confirm the latest failed question before authorizing another attempt.',
              );
            this.events.clear(
              context.profile,
              command.id,
              command.thread_id,
              command.turn_id,
            );
            this.local.putArtifact(
              context.profile,
              command.id,
              'chat-recovery',
              {
                thread_id: command.thread_id,
                turn_id: command.turn_id,
                resume_token: command.resume_token,
              },
            );
            this.hooks.changed();
            try {
              turn = bound(
                await context.api.request(
                  `/v1/chat-turns/${turn.id}/resume`,
                  chatTurnSchema,
                  {
                    method: 'POST',
                    body: {
                      confirmed: true,
                      resume_token: command.resume_token,
                    },
                    signal,
                  },
                ),
                command.id,
                command.thread_id,
                command.turn_id,
              );
            } catch (error) {
              if (
                error instanceof ClientError &&
                [
                  'question_not_resumable',
                  'question_resume_changed',
                  'question_input_changed',
                  'quota_exceeded',
                ].includes(error.code)
              ) {
                context.authorize();
                this.local.deleteArtifact(
                  context.profile,
                  command.id,
                  'chat-recovery',
                );
                this.hooks.changed();
              }
              throw error;
            }
          } else if (active(turn) || turn.state === 'failed') {
            this.events.clear(
              context.profile,
              command.id,
              command.thread_id,
              command.turn_id,
            );
            turn = bound(
              await context.api.request(
                `/v1/chat-turns/${turn.id}/cancel`,
                chatTurnSchema,
                { method: 'POST', body: { confirmed: true }, signal },
              ),
              command.id,
              command.thread_id,
              command.turn_id,
            );
          }
          context.authorize();
          this.available(context.profile, command.id, command.thread_id);
          this.local.atomic(() => {
            this.latest(context.profile, command.id, turn);
            if (command.action === 'resume' || existing)
              this.local.deleteArtifact(
                context.profile,
                command.id,
                'chat-recovery',
              );
          });
          this.hooks.changed();
          return turn;
        },
        command.thread_id,
      ),
    );
  }
  async source(command: Command<'getChatSource'>) {
    const owner = this.owner(command.scope, command.id);
    this.available(owner.profile, command.id, command.thread_id);
    const name = `${prefix(command.thread_id)}turn:${command.turn_id}`;
    let turn = this.local.getArtifact(
      owner.profile,
      command.id,
      name,
      chatTurnSchema,
    );
    if (!turn)
      turn = await this.remote(
        command.scope,
        command.id,
        async (context, signal) => {
          const value = bound(
            await context.api.request(
              `/v1/chat-turns/${command.turn_id}`,
              chatTurnSchema,
              { signal },
            ),
            command.id,
            command.thread_id,
            command.turn_id,
          );
          context.authorize();
          return this.remember(context.profile, command.id, value);
        },
        command.thread_id,
      );
    owner.authorize();
    bound(turn, command.id, command.thread_id, command.turn_id);
    if (
      turn.state !== 'succeeded' ||
      !turn.result?.answer.answer.citations.some(
        (citation) => citationKey(citation) === citationKey(command.citation),
      )
    )
      throw problem(
        'citation_not_found',
        'Only a completed answer can authorize this cited source.',
      );
    const sourceName = `${prefix(command.thread_id)}source:${command.turn_id}:${citationKey(command.citation)}`;
    const cached = this.local.getArtifact(
      owner.profile,
      command.id,
      sourceName,
      chatSourceSchema,
    );
    if (cached) return cached;
    return this.remote(
      command.scope,
      command.id,
      async (context, signal) => {
        const value = await context.api.request(
          `/v1/chat-turns/${command.turn_id}/citation`,
          chatSourceSchema,
          { method: 'POST', body: command.citation, signal },
        );
        context.authorize();
        this.available(context.profile, command.id, command.thread_id);
        if (
          value.document_id !== command.id ||
          value.turn_id !== command.turn_id ||
          citationKey(value.citation) !== citationKey(command.citation)
        )
          throw problem(
            'invalid_server_response',
            'The service returned another question source.',
          );
        this.local.putArtifact(context.profile, command.id, sourceName, value);
        return value;
      },
      command.thread_id,
    );
  }
  async remove(command: Command<'deleteChatThread'>) {
    if (command.confirmed !== true)
      throw problem(
        'chat_consent_required',
        'Confirm deleting this conversation.',
      );
    return this.write(command.scope, command.id, () =>
      this.remote(command.scope, command.id, async (context, signal) => {
        const pending = this.deleting(context.profile, command.id);
        const submission = this.local.getArtifact(
          context.profile,
          command.id,
          'chat-submission',
          chatIntentSchema,
        );
        if (
          !pending &&
          submission &&
          !submission.rejected &&
          !submission.turn_id
        )
          throw problem(
            'chat_request_unresolved',
            'Recover the saved question receipt before deleting a conversation; its accepted conversation is not yet known.',
          );
        if (pending && pending.thread_id !== command.thread_id)
          throw problem(
            'chat_deletion_pending',
            'Finish the earlier conversation deletion first.',
          );
        if (!pending)
          this.available(context.profile, command.id, command.thread_id);
        context.authorize();
        this.local.atomic(() => {
          this.local.putArtifact(context.profile, command.id, 'chat-deletion', {
            thread_id: command.thread_id,
          });
          this.forget(context.profile, command.id, command.thread_id);
        });
        this.hooks.changed();
        try {
          await context.api.request(
            `/v1/chat-threads/${command.thread_id}`,
            z.strictObject({ deleted: z.literal(true) }),
            { method: 'DELETE', body: { confirmed: true }, signal },
          );
        } catch (error) {
          if (
            !(error instanceof ClientError) ||
            error.code !== 'chat_not_found'
          )
            throw error;
          // A lost deletion reply is reconciled only after checking current document access.
          const document = await context.api.document(command.id, signal);
          if (document.id !== command.id)
            throw problem(
              'invalid_server_response',
              'The service returned another meeting.',
            );
        }
        context.authorize();
        this.local.deleteArtifact(context.profile, command.id, 'chat-deletion');
        this.hooks.changed();
      }),
    );
  }
}
