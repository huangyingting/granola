import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  createDocumentSchema,
  documentSchema,
  updateDocumentSchema,
  updateNotesSchema,
  makeTranscriptPage,
  type Segment,
  type Job,
  transcriptHeaderSchema,
  transcriptTimelineEntrySchema,
  jobSchema,
  jobEventSchema,
  finalizeTranscriptSchema,
  applyTranscriptSchema,
  accountUsageSchema,
  DEFAULT_AI_LIMITS,
  LONG_SUMMARY_VERSION,
  summaryRequestSchema,
  citationSchema,
  citationKey,
  type SummarySnapshot,
} from '@windows-ai-notes/contracts/server';
import {
  summaryCitations,
  summarySourceSchema,
} from '@windows-ai-notes/contracts/generation';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import { oidcFixture } from './oidc.fixture.js';
import {
  DEFAULT_SUMMARY_TEMPLATE,
  SUMMARY_TEMPLATES,
} from '@windows-ai-notes/contracts/templates';
import { summaryProgressSchema } from '@windows-ai-notes/contracts/evidence';
import {
  CHAT_VERSION,
  QUESTION_PROMPT_VERSION,
  QUESTION_CONTEXT_PROMPT_VERSION,
  chatSubmissionSchema,
  chatResumeSchema,
  chatThreadSchema,
  chatTurnSchema,
  chatEventSchema,
  chatEventStateSchema,
  chatPreviewSchema,
  insufficientQuestionEvidence,
  type ChatTurn,
  type ChatSource,
} from '@windows-ai-notes/contracts/questions';

type Document = z.infer<typeof documentSchema>;
type Change = {
  seq: string;
  document_id: string;
  kind: 'document' | 'transcript' | 'job' | 'deleted';
  revision: number;
  transcript_revision: number;
  job_id: string | null;
  created_at: string;
};

// Windows UI tests use real HTTP/OIDC without requiring PostgreSQL on the runner.
// The coordinator's integration tests separately exercise the actual API/database.
export async function desktopFixture() {
  const issuer = await oidcFixture();
  const user = randomUUID();
  const workspace = randomUUID();
  const documents = new Map<string, Document>();
  const changes: { workspace: string; value: Change }[] = [];
  const transcripts = new Map<
    string,
    Omit<z.infer<typeof transcriptHeaderSchema>, 'total_segments'> & {
      segments: Segment[];
    }
  >();
  const timelines = new Map<
    string,
    z.infer<typeof transcriptTimelineEntrySchema>[]
  >();
  const jobs = new Map<string, Job>();
  const chatTurns = new Map<string, ChatTurn>();
  const chatThreads = new Map<string, z.infer<typeof chatThreadSchema>>();
  const chatSnapshots = new Map<
    string,
    { units: ChatSource['excerpts']; context: boolean }
  >();
  const chatReceipts = new Map<string, { hash: string; turn: string }>();
  const chatResumes = new Map<string, Set<string>>();
  const chatEvents = new Map<string, z.infer<typeof chatEventSchema>[]>();
  const chatPreviews = new Map<
    string,
    { attempt: number; text: string | null }
  >();
  function chatEvent(
    id: string,
    type: z.infer<typeof chatEventSchema>['event_type'],
    payload: unknown,
  ) {
    const turn = chatTurns.get(id);
    if (!turn) throw new Error('Missing synthetic question event owner.');
    const value = chatEventSchema.parse({
      turn_id: id,
      seq: turn.last_event_id + 1,
      event_type: type,
      schema_version: 1,
      created_at: new Date().toISOString(),
      payload,
    });
    const rows = chatEvents.get(id) ?? [];
    rows.push(value);
    chatEvents.set(id, rows);
    chatTurns.set(id, { ...turn, last_event_id: value.seq });
  }
  const events = new Map<string, z.infer<typeof jobEventSchema>[]>();
  function event(
    id: string,
    type: z.infer<typeof jobEventSchema>['event_type'],
    payload: unknown,
  ) {
    const rows = events.get(id) ?? [];
    rows.push(
      jobEventSchema.parse({
        job_id: id,
        seq: rows.length + 1,
        event_type: type,
        payload,
        schema_version: 1,
        created_at: new Date().toISOString(),
      }),
    );
    events.set(id, rows);
  }
  const summarySnapshots = new Map<string, SummarySnapshot>();
  const summaryStages = new Map<
    string,
    {
      token: string;
      requests: number;
      uncertain: number;
      completed: number;
      resumes: Set<string>;
    }
  >();
  const recordings = new Map<
    string,
    {
      document_id: string;
      id: string;
      track_id: string;
      seal_sha256: string;
      partial: boolean;
    }
  >();
  const replays = new Map<string, { hash: string; value: unknown }>();
  const tombstones = new Set<string>();
  const today = new Date();
  const usage = accountUsageSchema.parse({
    period_start: new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10),
    period_end: new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
    )
      .toISOString()
      .slice(0, 10),
    limits: {
      input_tokens: String(DEFAULT_AI_LIMITS.input_tokens),
      output_tokens: String(DEFAULT_AI_LIMITS.output_tokens),
      audio_ms: String(DEFAULT_AI_LIMITS.audio_ms),
    },
    settled: { input_tokens: '0', output_tokens: '0', audio_ms: '0' },
    uncertain: { input_tokens: '0', output_tokens: '0', audio_ms: '0' },
    settled_requests: '0',
    uncertain_requests: '0',
    over_limit: false,
  });
  const state = {
    active: true,
    transcript_online: true,
    user,
    workspace,
    documents,
    jobs,
    lose_finalization_response: false,
    lose_summary_response: false,
    lose_summary_resume_response: false,
    summary_resume_tokens: [] as string[],
    summary_event_cursors: [] as number[],
    summary_online: true,
    chatTurns,
    lose_chat_response: false,
    change_chat_before_submit: false,
    lose_chat_resume_response: false,
    lose_chat_delete_response: false,
    chat_resume_tokens: [] as string[],
    chat_event_cursors: [] as number[],
    chat_online: true,
    workspaces: [{ id: workspace, name: 'Synthetic cloud workspace' }],
    failures: [] as unknown[],
    usage,
  };
  const keys = createRemoteJWKSet(new URL('keys', issuer.state.issuer));
  function record(
    document: Document,
    kind: Change['kind'] = 'document',
    jobId: string | null = null,
  ) {
    changes.push({
      workspace: document.workspace_id,
      value: {
        seq: String(changes.length + 1),
        document_id: document.id,
        kind,
        revision: document.revision,
        transcript_revision: document.transcript_revision,
        job_id: jobId,
        created_at: new Date().toISOString(),
      },
    });
  }
  function seed(text: string, transcript?: string | Segment[]) {
    const document = documentSchema.parse({
      id: randomUUID(),
      workspace_id: workspace,
      owner_id: user,
      title: 'Synthetic cloud meeting',
      notes: text,
      content: null,
      tags: [],
      revision: 1,
      transcript_revision: transcript ? 1 : 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    documents.set(document.id, document);
    if (transcript)
      transcripts.set(`${document.id}:1`, {
        document_id: document.id,
        revision: 1,
        source: 'manual',
        segments:
          typeof transcript === 'string'
            ? [
                {
                  id: randomUUID(),
                  start_ms: 0,
                  end_ms: 1000,
                  text: transcript,
                },
              ]
            : transcript,
      });
    record(document);
    return document;
  }
  function change(id: string, text: string) {
    const old = documents.get(id);
    if (!old) throw new Error('Missing synthetic document.');
    const next = {
      ...old,
      notes: text,
      content: null,
      revision: old.revision + 1,
      updated_at: new Date().toISOString(),
    };
    documents.set(id, next);
    record(next);
  }
  function remove(id: string) {
    const document = documents.get(id);
    if (!document) throw new Error('Missing synthetic document.');
    record(document, 'deleted');
    documents.delete(id);
    tombstones.add(id);
  }
  function transcript(id: string, text: string) {
    const document = documents.get(id);
    if (!document) throw new Error('Missing synthetic transcript document.');
    const revision =
      Math.max(
        0,
        ...[...transcripts.values()]
          .filter((value) => value.document_id === id)
          .map((value) => value.revision),
      ) + 1;
    transcripts.set(`${id}:${revision}`, {
      document_id: id,
      revision,
      source: 'manual',
      segments: [{ id: randomUUID(), start_ms: 0, end_ms: 1000, text }],
    });
    const next = { ...document, transcript_revision: revision };
    documents.set(id, next);
    record(next, 'transcript');
  }
  function publishCandidate(id: string) {
    const job = jobs.get(id);
    const source = job?.recording_id ? recordings.get(job.recording_id) : null;
    const document = job ? documents.get(job.document_id) : null;
    if (!job || !source || !document)
      throw new Error('Missing synthetic recording transcription.');
    const revision =
      Math.max(
        0,
        ...[...transcripts.values()]
          .filter((value) => value.document_id === document.id)
          .map((value) => value.revision),
      ) + 1;
    const epoch = randomUUID();
    const timeline: z.infer<typeof transcriptTimelineEntrySchema>[] = [
      {
        kind: 'event',
        value: {
          event_type: 'capture.started',
          clock_ms: 0,
          capture_epoch: epoch,
          code: null,
        },
      },
      {
        kind: 'gap',
        value: {
          track_id: source.track_id,
          start_ms: 500,
          end_ms: 900,
          reason: 'paused',
        },
      },
    ];
    transcripts.set(`${document.id}:${revision}`, {
      document_id: document.id,
      revision,
      source: 'azure_speech_fast',
      is_candidate: true,
      based_on_revision: 1,
      recording: {
        id: source.id,
        seal_sha256: source.seal_sha256,
        partial: source.partial,
        tracks: [{ track_id: source.track_id, kind: 'microphone' }],
        timeline_count: timeline.length,
      },
      segments: [
        {
          id: randomUUID(),
          start_ms: 0,
          end_ms: 400,
          text: 'Synthetic generated recording evidence.',
          origin: {
            recording_id: source.id,
            track_id: source.track_id,
            kind: 'microphone',
            capture_epoch: epoch,
            chunk_id: randomUUID(),
            start_offset_ms: 0,
            end_offset_ms: 400,
            time_basis: 'chunk_clock_linear',
          },
        },
      ],
    });
    timelines.set(`${document.id}:${revision}`, timeline);
    jobs.set(
      id,
      jobSchema.parse({
        ...job,
        state: 'succeeded',
        attempt: 1,
        input_stale: true,
        progress: {
          completed_chunks: 1,
          total_chunks: 1,
          audio_ms: 1000,
          uncertain_requests: 0,
        },
        result: {
          kind: 'recording_transcription',
          recording_id: source.id,
          transcript_revision: revision,
          segment_count: 1,
          processed_chunks: 1,
          uncertain_requests: 0,
          applied: false,
          partial: source.partial,
          provider: 'fixture',
          configuration_version: 'synthetic-recording-v1',
          usage: { input_tokens: 0, output_tokens: 0, audio_ms: 1000 },
        },
      }),
    );
    record(document, 'job', id);
  }
  function publishSummary(id: string) {
    const job = jobs.get(id),
      snapshot = summarySnapshots.get(id);
    const document = job ? documents.get(job.document_id) : null;
    if (!job || !snapshot || !document)
      throw new Error('Missing synthetic summary.');
    const stages = summaryStages.get(id)!;
    stages.requests++;
    stages.completed = 1;
    const note = {
      source: 'note' as const,
      id: snapshot.document_id,
      revision: snapshot.note_revision,
    };
    const segment = snapshot.segments[0];
    const fact = {
      text: 'Synthetic generated summary for review.',
      citations: [note],
    };
    const next = jobSchema.parse({
      ...job,
      state: 'succeeded',
      attempt: 1,
      input_stale:
        document.revision !== snapshot.note_revision ||
        document.transcript_revision !== snapshot.transcript_revision,
      result: {
        kind: 'summary',
        summary: {
          overview: fact,
          topics: [{ ...fact, text: 'Synthetic discussion topic.' }],
          decisions: segment
            ? [
                {
                  text: 'Verify the cited synthetic decision.',
                  citations: [
                    {
                      source: 'transcript',
                      id: segment.id,
                      revision: snapshot.transcript_revision,
                    },
                  ],
                },
              ]
            : [],
          action_items: [
            {
              ...fact,
              text: 'Verify the reviewed draft.',
              owner: null,
              due_date: null,
            },
          ],
          open_questions: [
            { ...fact, text: 'Which details still need verification?' },
          ],
        },
        provider: 'fixture',
        configuration_version: 'synthetic-summary-v1',
        prompt_version: snapshot.template_id ?? DEFAULT_SUMMARY_TEMPLATE,
        usage: { input_tokens: 100, output_tokens: 80, audio_ms: 0 },
      },
    });
    jobs.set(id, next);
    event(id, 'output.completed', next.result);
    record(document, 'job', id);
  }
  function previewSummary(id: string, text: string) {
    const job = jobs.get(id);
    if (!job || job.kind !== 'summary')
      throw new Error('Missing synthetic summary.');
    const attempt = Math.max(1, job.attempt);
    jobs.set(id, { ...job, state: 'running', attempt });
    event(id, 'job.progress', {
      stage: 'summary_preview',
      version: 1,
      attempt,
      text,
    });
  }
  function failSummary(id: string) {
    const job = jobs.get(id),
      stages = summaryStages.get(id);
    const document = job ? documents.get(job.document_id) : null;
    if (
      !job ||
      !stages ||
      !document ||
      !['queued', 'running'].includes(job.state)
    )
      throw new Error('Missing active synthetic summary.');
    stages.requests++;
    stages.uncertain++;
    event(id, 'job.failed', { code: 'summary_dispatch_unconfirmed' });
    jobs.set(id, {
      ...job,
      state: 'failed',
      attempt: job.attempt + 1,
      error: {
        code: 'summary_dispatch_unconfirmed',
        message: 'Synthetic summary response loss.',
        retryable: false,
      },
    });
    record(document, 'job', id);
  }
  function chatTurn(id: string) {
    const turn = chatTurns.get(id),
      document = turn ? documents.get(turn.document_id) : null;
    return turn && document
      ? {
          ...turn,
          input_stale:
            turn.request.note_revision !== document.revision ||
            turn.request.transcript_revision !== document.transcript_revision,
        }
      : null;
  }
  function publishChat(id: string) {
    const turn = chatTurn(id),
      snapshot = chatSnapshots.get(id);
    if (!turn || !snapshot || !['queued', 'running'].includes(turn.state))
      throw new Error('Missing active synthetic question.');
    const citations = [
      ...new Map(
        snapshot.units.map((unit) => [
          citationKey(unit.citation),
          unit.citation,
        ]),
      ).values(),
    ].slice(0, 16);
    const usage = {
      input_tokens: citations.length ? 70 : 0,
      output_tokens: citations.length ? 18 : 0,
      audio_ms: 0,
    };
    chatTurns.set(
      id,
      chatTurnSchema.parse({
        ...turn,
        state: 'succeeded',
        attempt: turn.attempt + Number(turn.state === 'queued'),
        error: null,
        resume_available: false,
        resume_token: null,
        provider_requests:
          turn.provider_requests +
          Number(citations.length > 0 && turn.state === 'queued'),
        result: {
          answer: citations.length
            ? {
                status: 'answered',
                answer: {
                  text:
                    turn.request.language === 'zh'
                      ? '清单负责人是 Mira，截止日期为周五。'
                      : 'Mira owns the launch checklist. It is due Friday.',
                  citations,
                },
              }
            : insufficientQuestionEvidence(turn.request.language),
          provider: 'fixture',
          configuration_version: 'synthetic-chat-v1',
          prompt_version: snapshot.context
            ? QUESTION_CONTEXT_PROMPT_VERSION
            : QUESTION_PROMPT_VERSION,
          usage,
        },
      }),
    );
    const previous = chatPreviews.get(id)!;
    chatPreviews.set(id, {
      attempt: previous.attempt + Number(turn.state === 'queued'),
      text: null,
    });
    chatEvent(id, 'answer.completed', { state: 'succeeded' });
  }
  function previewChat(id: string, text: string) {
    const turn = chatTurn(id),
      previous = chatPreviews.get(id);
    if (
      !turn ||
      !previous ||
      !['queued', 'running'].includes(turn.state) ||
      !chatSnapshots.get(id)?.units.length
    )
      throw new Error('Missing synthetic question preview owner.');
    const attempt = previous.attempt + Number(turn.state === 'queued');
    if (!text.startsWith(previous.text ?? ''))
      throw new Error('Synthetic question preview changed its prefix.');
    if (turn.state === 'queued') {
      chatTurns.set(id, {
        ...turn,
        state: 'running',
        attempt: turn.attempt + 1,
        provider_requests: turn.provider_requests + 1,
      });
      chatEvent(id, 'turn.progress', { stage: 'preparing', attempt });
      chatEvent(
        id,
        'turn.progress',
        chatPreviewSchema.parse({ version: 1, attempt, text: '' }),
      );
    }
    chatPreviews.set(id, { attempt, text });
    chatEvent(
      id,
      'turn.progress',
      chatPreviewSchema.parse({ version: 1, attempt, text }),
    );
  }
  function failChat(id: string) {
    const turn = chatTurn(id);
    if (!turn || !['queued', 'running'].includes(turn.state))
      throw new Error('Missing active synthetic question.');
    const attempt = turn.attempt + Number(turn.state === 'queued');
    const resumable = attempt < 3;
    chatTurns.set(
      id,
      chatTurnSchema.parse({
        ...turn,
        state: 'failed',
        attempt,
        provider_requests:
          turn.provider_requests + Number(turn.state === 'queued'),
        uncertain_requests: turn.uncertain_requests + 1,
        resume_available: resumable,
        resume_token: resumable ? randomUUID() : null,
        error: {
          code: 'question_dispatch_unconfirmed',
          message: 'Synthetic lost question response.',
          retryable: false,
        },
      }),
    );
    chatPreviews.set(id, {
      attempt: chatPreviews.get(id)!.attempt + Number(turn.state === 'queued'),
      text: null,
    });
    chatEvent(id, 'turn.failed', { code: 'question_dispatch_unconfirmed' });
  }
  function send(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(status === 204 ? undefined : JSON.stringify(value));
  }
  function error(response: ServerResponse, code: string, status: number) {
    send(
      response,
      {
        code,
        message: `Synthetic ${code.replaceAll('_', ' ')}.`,
        retryable: false,
        request_id: randomUUID(),
      },
      status,
    );
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      const path = url.pathname;
      if (path === '/v1/client-config')
        return send(response, issuer.configuration);
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer '))
        return error(response, 'unauthorized', 401);
      try {
        const token = await jwtVerify(authorization.slice(7), keys, {
          issuer: issuer.state.issuer,
          audience: issuer.configuration.audience,
          algorithms: ['RS256'],
        });
        if (
          token.payload.sub !== issuer.state.subject ||
          token.payload.scp !== 'notes.access'
        )
          return error(response, 'unauthorized', 401);
      } catch {
        return error(response, 'unauthorized', 401);
      }
      if (!state.active)
        return error(response, 'identity_not_provisioned', 403);
      if (path === '/v1/me') return send(response, { id: user });
      if (path === '/v1/usage') return send(response, state.usage);
      if (path === '/v1/templates')
        return send(response, { templates: SUMMARY_TEMPLATES });
      if (path === '/v1/summary-capabilities')
        return send(response, { long_meetings: LONG_SUMMARY_VERSION });
      if (path === '/v1/chat-capabilities')
        return send(response, {
          questions: CHAT_VERSION,
          max_attempts: 3,
          max_pending_work: 8,
          history_context: 'meeting-question-context-v1',
        });
      if (path === '/v1/workspaces')
        return send(response, { workspaces: state.workspaces });
      if (path === '/v1/sync/snapshot') {
        const id = url.searchParams.get('workspace_id');
        return send(response, {
          documents: [...documents.values()].filter(
            (document) => document.workspace_id === id,
          ),
          cursor: `fixture${changes.length}`,
          next_after: null,
          has_more: false,
        });
      }
      if (path === '/v1/sync/changes') {
        const after = Number(
          url.searchParams.get('cursor')?.replace(/^fixture/u, ''),
        );
        return send(response, {
          changes: changes
            .filter(
              (change) =>
                change.workspace === url.searchParams.get('workspace_id') &&
                Number(change.value.seq) > after,
            )
            .map((change) => change.value),
          cursor: `fixture${changes.length}`,
          has_more: false,
        });
      }
      const parts = path.split('/');
      const id = parts[3] ?? '';
      const existing = documents.get(id);
      if (
        ['chat-turns', 'chat-threads'].includes(parts[2] ?? '') &&
        !state.chat_online
      )
        return error(response, 'service_unavailable', 503);
      if (request.method === 'GET' && parts[2] === 'chat-turns') {
        const turn = chatTurn(id);
        if (!turn) return error(response, 'chat_not_found', 404);
        if (parts[4] === 'event-state') {
          const preview = chatPreviews.get(id)!;
          return send(
            response,
            chatEventStateSchema.parse({
              turn,
              preview_attempt: preview.attempt,
              preview:
                turn.state === 'running' && preview.text !== null
                  ? { version: 1, attempt: preview.attempt, text: preview.text }
                  : null,
            }),
          );
        }
        if (parts[4] === 'events') {
          let cursor = Number(request.headers['last-event-id'] ?? 0);
          if (
            !Number.isInteger(cursor) ||
            cursor < 0 ||
            cursor > turn.last_event_id
          )
            return error(response, 'invalid_event_cursor', 400);
          const first = chatEvents.get(id)?.[0]?.seq ?? turn.last_event_id + 1;
          if (cursor < first - 1)
            return error(response, 'event_cursor_expired', 410);
          state.chat_event_cursors.push(cursor);
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
          });
          let closed = false,
            heartbeat = Date.now();
          response.once('close', () => {
            closed = true;
          });
          while (
            !closed &&
            state.active &&
            state.chat_online &&
            documents.has(turn.document_id) &&
            chatTurns.has(id)
          ) {
            for (const value of (chatEvents.get(id) ?? []).filter(
              (value) => value.seq > cursor,
            )) {
              response.write(
                `id: ${value.seq}\nevent: ${value.event_type}\ndata: ${JSON.stringify(value)}\n\n`,
              );
              cursor = value.seq;
            }
            if (!['queued', 'running'].includes(chatTurns.get(id)!.state))
              break;
            if (Date.now() - heartbeat > 1000) {
              response.write(': heartbeat\n\n');
              heartbeat = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          response.end();
          return;
        }
        return turn
          ? send(response, turn)
          : error(response, 'chat_not_found', 404);
      }
      if (request.method === 'GET' && parts[2] === 'chat-threads') {
        const thread = chatThreads.get(id);
        if (!thread || !documents.has(thread.document_id))
          return error(response, 'chat_not_found', 404);
        const after = Number(url.searchParams.get('after') ?? 0);
        const turns = [...chatTurns.values()]
          .filter((turn) => turn.thread_id === id && turn.position > after)
          .sort((a, b) => a.position - b.position);
        return send(response, {
          turns: turns.slice(0, 50).map((turn) => chatTurn(turn.id)),
          has_more: turns.length > 50,
        });
      }
      if (request.method === 'GET' && parts[2] === 'jobs') {
        const job = jobs.get(id);
        if (parts[4] === 'event-state') {
          if (!job || !documents.has(job.document_id))
            return error(response, 'job_not_found', 404);
          return send(response, {
            job,
            last_event_id: events.get(id)?.length ?? 0,
            completed_stages: summaryStages.get(id)?.completed ?? 0,
          });
        }
        if (parts[4] === 'events') {
          if (!job || !documents.has(job.document_id))
            return error(response, 'job_not_found', 404);
          let cursor = Number(request.headers['last-event-id'] ?? 0);
          state.summary_event_cursors.push(cursor);
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
          });
          let closed = false,
            heartbeat = Date.now();
          response.once('close', () => {
            closed = true;
          });
          while (!closed && state.active && documents.has(job.document_id)) {
            for (const value of (events.get(id) ?? []).filter(
              (value) => value.seq > cursor,
            )) {
              response.write(
                `id: ${value.seq}\nevent: ${value.event_type}\ndata: ${JSON.stringify(value)}\n\n`,
              );
              cursor = value.seq;
            }
            if (
              !['queued', 'running', 'retry_wait'].includes(jobs.get(id)!.state)
            )
              break;
            if (Date.now() - heartbeat > 1000) {
              response.write(': heartbeat\n\n');
              heartbeat = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          response.end();
          return;
        }
        if (parts[4] === 'summary-progress') {
          const stages = summaryStages.get(id);
          if (!job || !documents.has(job.document_id))
            return error(response, 'job_not_found', 404);
          if (!stages) return error(response, 'unsupported_summary_job', 409);
          const resume = job.state === 'failed';
          return send(
            response,
            summaryProgressSchema.parse({
              document_id: job.document_id,
              job_id: id,
              state: job.state,
              total_stages: 1,
              completed_stages: stages.completed,
              provider_requests: stages.requests,
              uncertain_requests: stages.uncertain,
              resume_available: resume,
              resume_token: resume ? stages.token : null,
            }),
          );
        }
        return job
          ? send(response, job)
          : error(response, 'job_not_found', 404);
      }
      if (request.method === 'GET' && parts[2] === 'documents') {
        if (!existing) return error(response, 'document_not_found', 404);
        if (parts[4] === 'chat-threads') {
          if (!state.chat_online)
            return error(response, 'service_unavailable', 503);
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const threads = [...chatThreads.values()]
            .filter((thread) => thread.document_id === id)
            .sort(
              (a, b) =>
                b.created_at.localeCompare(a.created_at) ||
                b.id.localeCompare(a.id),
            );
          return send(response, {
            threads: threads.slice(offset, offset + 50),
            has_more: threads.length > offset + 50,
          });
        }
        if (parts[4] === 'jobs')
          return send(response, {
            jobs: [...jobs.values()]
              .reverse()
              .filter((job) => job.document_id === id)
              .slice(0, 20),
          });
        if (parts[4] === 'transcript') {
          if (!state.transcript_online)
            return error(response, 'service_unavailable', 503);
          const transcript = transcripts.get(
            `${id}:${url.searchParams.get('revision')}`,
          );
          if (!transcript) return error(response, 'transcript_not_found', 404);
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (parts[5] === 'timeline') {
            const entries = timelines.get(`${id}:${transcript.revision}`) ?? [];
            return send(response, {
              document_id: id,
              revision: transcript.revision,
              offset,
              total: entries.length,
              entries: entries.slice(offset, offset + 50),
              has_more: offset + 50 < entries.length,
            });
          }
          const { segments, ...header } = transcript;
          return send(
            response,
            parts[5] === 'pages'
              ? makeTranscriptPage(
                  {
                    ...header,
                    total_segments: segments.length,
                  },
                  offset,
                  transcript.segments.slice(offset),
                )
              : transcript,
          );
        }
        return send(response, existing);
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 1024 * 1024)
          throw new Error('Synthetic request exceeded its bound.');
        chunks.push(bytes);
      }
      const body: unknown = length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : null;
      const key = `${request.method}:${path}:${request.headers['idempotency-key']}`;
      const hash = canonicalJson(body);
      if (
        request.method === 'POST' &&
        parts[2] === 'documents' &&
        parts[4] === 'chat-turns'
      ) {
        if (!existing) return error(response, 'document_not_found', 404);
        if (!state.chat_online)
          return error(response, 'service_unavailable', 503);
        const value = chatSubmissionSchema.parse(body),
          digest = createHash('sha256').update(hash).digest('hex'),
          receipt = chatReceipts.get(key);
        if (receipt) {
          if (receipt.hash !== digest)
            return error(response, 'idempotency_conflict', 409);
          const turn = chatTurn(receipt.turn);
          return turn
            ? send(response, turn, 202)
            : error(response, 'chat_request_deleted', 410);
        }
        if (state.change_chat_before_submit) {
          state.change_chat_before_submit = false;
          change(
            id,
            `${existing.notes}\nNew synthetic evidence after preparation.`,
          );
          return error(response, 'revision_conflict', 409);
        }
        if (
          value.note_revision !== existing.revision ||
          value.transcript_revision !== existing.transcript_revision
        )
          return error(response, 'revision_conflict', 409);
        const old = value.thread_id
          ? chatThreads.get(value.thread_id)
          : undefined;
        if (value.thread_id && (!old || old.document_id !== id))
          return error(response, 'chat_not_found', 404);
        if (
          old &&
          [...chatTurns.values()].some(
            (turn) =>
              turn.thread_id === old.id &&
              ['queued', 'running'].includes(turn.state),
          )
        )
          return error(response, 'chat_turn_pending', 409);
        const thread = old
          ? { ...old, last_position: old.last_position + 1 }
          : {
              id: randomUUID(),
              document_id: id,
              title: value.question.trim().slice(0, 200),
              last_position: 1,
              created_at: new Date().toISOString(),
            };
        const turn = chatTurnSchema.parse({
          id: randomUUID(),
          thread_id: thread.id,
          document_id: id,
          position: thread.last_position,
          request: value,
          mode: 'full',
          state: 'queued',
          attempt: 0,
          input_stale: false,
          result: null,
          error: null,
          resume_available: false,
          resume_token: null,
          provider_requests: 0,
          uncertain_requests: 0,
          last_event_id: 0,
          created_at: new Date().toISOString(),
        });
        const units: ChatSource['excerpts'] = existing.notes.trim()
          ? [
              {
                citation: { source: 'note', id, revision: existing.revision },
                text: existing.notes,
                text_start: 0,
                text_end: existing.notes.length,
                start_ms: null,
                end_ms: null,
                overlap: false,
              },
            ]
          : [];
        for (const segment of transcripts.get(
          `${id}:${existing.transcript_revision}`,
        )?.segments ?? [])
          units.push({
            citation: {
              source: 'transcript',
              id: segment.id,
              revision: existing.transcript_revision,
            },
            text: segment.text,
            text_start: 0,
            text_end: segment.text.length,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            overlap: false,
          });
        const context = [...chatTurns.values()].some(
          (previous) =>
            previous.thread_id === thread.id && previous.state === 'succeeded',
        );
        chatThreads.set(thread.id, chatThreadSchema.parse(thread));
        chatTurns.set(turn.id, turn);
        chatPreviews.set(turn.id, { attempt: 0, text: null });
        chatEvent(turn.id, 'turn.accepted', {
          thread_id: turn.thread_id,
          position: turn.position,
        });
        chatSnapshots.set(turn.id, { units, context });
        chatReceipts.set(key, { hash: digest, turn: turn.id });
        if (state.lose_chat_response) {
          state.lose_chat_response = false;
          response.destroy();
          return;
        }
        return send(response, chatTurn(turn.id), 202);
      }
      if (parts[2] === 'chat-turns' && request.method === 'POST') {
        let turn = chatTurn(id);
        if (!turn) return error(response, 'chat_not_found', 404);
        if (parts[4] === 'citation') {
          const citation = citationSchema.parse(body);
          if (
            !turn.result?.answer.answer.citations.some(
              (item) => citationKey(item) === citationKey(citation),
            )
          )
            return error(response, 'citation_not_found', 404);
          return send(response, {
            document_id: turn.document_id,
            turn_id: id,
            citation,
            excerpts: chatSnapshots
              .get(id)!
              .units.filter(
                (unit) => citationKey(unit.citation) === citationKey(citation),
              ),
          });
        }
        if (parts[4] === 'resume') {
          const value = chatResumeSchema.parse(body);
          state.chat_resume_tokens.push(value.resume_token);
          const tokens = chatResumes.get(id) ?? new Set<string>();
          if (!tokens.has(value.resume_token)) {
            if (
              !turn.resume_available ||
              turn.resume_token !== value.resume_token
            )
              return error(response, 'question_not_resumable', 409);
            tokens.add(value.resume_token);
            chatResumes.set(id, tokens);
            turn = {
              ...turn,
              state: 'queued',
              error: null,
              resume_available: false,
              resume_token: null,
            };
            chatTurns.set(id, turn);
            chatPreviews.set(id, {
              attempt: chatPreviews.get(id)!.attempt + 1,
              text: null,
            });
            chatEvent(id, 'turn.accepted', { resumed: true });
            turn = chatTurn(id)!;
          }
          if (state.lose_chat_resume_response) {
            state.lose_chat_resume_response = false;
            response.destroy();
            return;
          }
          return send(response, turn, 202);
        }
        if (parts[4] === 'cancel') {
          z.strictObject({ confirmed: z.literal(true) }).parse(body);
          if (!['succeeded', 'cancelled'].includes(turn.state)) {
            turn = {
              ...turn,
              state: 'cancelled',
              error: null,
              resume_available: false,
              resume_token: null,
            };
            chatTurns.set(id, turn);
            chatPreviews.set(id, {
              attempt: chatPreviews.get(id)!.attempt + 1,
              text: null,
            });
            chatEvent(id, 'turn.cancelled', {});
            turn = chatTurn(id)!;
            chatSnapshots.delete(id);
          }
          return send(response, turn);
        }
      }
      if (parts[2] === 'chat-threads' && request.method === 'DELETE') {
        const thread = chatThreads.get(id);
        if (!thread || !documents.has(thread.document_id))
          return error(response, 'chat_not_found', 404);
        z.strictObject({ confirmed: z.literal(true) }).parse(body);
        for (const turn of chatTurns.values())
          if (turn.thread_id === id) {
            chatTurns.delete(turn.id);
            chatSnapshots.delete(turn.id);
            chatResumes.delete(turn.id);
            chatPreviews.delete(turn.id);
            chatEvents.delete(turn.id);
          }
        chatThreads.delete(id);
        if (state.lose_chat_delete_response) {
          state.lose_chat_delete_response = false;
          response.destroy();
          return;
        }
        return send(response, { deleted: true });
      }
      const replay = replays.get(key);
      if (replay) {
        if (hash !== replay.hash)
          return error(response, 'idempotency_conflict', 409);
        return send(response, replay.value, replay.value ? 200 : 204);
      }
      if (
        request.method === 'POST' &&
        parts[2] === 'recordings' &&
        parts[4] === 'finalize-transcript'
      ) {
        const source = recordings.get(id),
          value = finalizeTranscriptSchema.parse(body);
        const document = source ? documents.get(source.document_id) : null;
        if (!source || !document)
          return error(response, 'recording_not_found', 404);
        if (
          source.seal_sha256 !== value.seal_sha256 ||
          (source.partial && !value.accept_incomplete)
        )
          return error(response, 'recording_source_changed', 409);
        if (document.transcript_revision !== value.base_revision)
          return error(response, 'revision_conflict', 409);
        const job = jobSchema.parse({
          id: randomUUID(),
          document_id: document.id,
          recording_id: source.id,
          kind: 'recording_transcription',
          state: 'queued',
          attempt: 0,
          input_stale: false,
          result: null,
          error: null,
          created_at: new Date().toISOString(),
          progress: {
            completed_chunks: 0,
            total_chunks: 1,
            audio_ms: 0,
            uncertain_requests: 0,
          },
        });
        jobs.set(job.id, job);
        replays.set(key, { hash, value: job });
        record(document, 'job', job.id);
        if (state.lose_finalization_response) {
          state.lose_finalization_response = false;
          response.destroy();
          return;
        }
        return send(response, job, 202);
      }
      if (
        request.method === 'POST' &&
        parts[2] === 'documents' &&
        parts[4] === 'summary-runs'
      ) {
        if (!existing) return error(response, 'document_not_found', 404);
        const value = summaryRequestSchema.parse(body);
        if (
          existing.revision !== value.note_revision ||
          existing.transcript_revision !== value.transcript_revision
        )
          return error(response, 'revision_conflict', 409);
        const snapshot: SummarySnapshot = {
          document_id: id,
          note_revision: value.note_revision,
          transcript_revision: value.transcript_revision,
          language: value.language,
          ...(value.template_id === undefined
            ? {}
            : { template_id: value.template_id }),
          notes: existing.notes,
          segments: structuredClone(
            transcripts.get(`${id}:${value.transcript_revision}`)?.segments ??
              [],
          ),
        };
        const job = jobSchema.parse({
          id: randomUUID(),
          document_id: id,
          kind: 'summary',
          state: 'queued',
          attempt: 0,
          input_stale: false,
          result: null,
          error: null,
          created_at: new Date().toISOString(),
        });
        jobs.set(job.id, job);
        summarySnapshots.set(job.id, snapshot);
        summaryStages.set(job.id, {
          token: randomUUID(),
          requests: 0,
          uncertain: 0,
          completed: 0,
          resumes: new Set(),
        });
        event(job.id, 'job.accepted', { state: 'queued' });
        replays.set(key, { hash, value: job });
        record(existing, 'job', job.id);
        if (state.lose_summary_response) {
          state.lose_summary_response = false;
          response.destroy();
          return;
        }
        return send(response, job, 202);
      }
      if (request.method === 'POST' && parts[2] === 'jobs') {
        const job = jobs.get(id),
          document = job ? documents.get(job.document_id) : null;
        if (!job || !document) return error(response, 'job_not_found', 404);
        if (parts[4] === 'citation') {
          if (!state.summary_online)
            return error(response, 'service_unavailable', 503);
          const selected = citationSchema.parse(body),
            snapshot = summarySnapshots.get(id);
          if (
            !snapshot ||
            job.state !== 'succeeded' ||
            job.result?.kind !== 'summary'
          )
            return error(response, 'summary_unavailable', 409);
          if (
            !summaryCitations(job.result.summary).some(
              (item) =>
                item.source === selected.source &&
                item.id === selected.id &&
                item.revision === selected.revision,
            )
          )
            return error(response, 'citation_not_found', 404);
          const segment = snapshot.segments.find(
            (item) => item.id === selected.id,
          );
          return send(
            response,
            summarySourceSchema.parse({
              document_id: document.id,
              job_id: id,
              citation: selected,
              text: selected.source === 'note' ? snapshot.notes : segment?.text,
              start_ms: segment?.start_ms ?? null,
              end_ms: segment?.end_ms ?? null,
            }),
          );
        }
        if (parts[4] === 'cancel') {
          const terminal = ['succeeded', 'failed', 'cancelled'].includes(
            job.state,
          );
          const next = terminal ? job : { ...job, state: 'cancelled' as const };
          jobs.set(id, next);
          record(document, 'job', id);
          return send(response, { already_terminal: terminal, job: next });
        }
        if (parts[4] === 'retry') {
          const value = z
            .strictObject({
              confirmed: z.literal(true),
              resume_token: z.uuid().optional(),
            })
            .parse(body);
          if (job.kind === 'summary') {
            const stages = summaryStages.get(id)!;
            if (!value.resume_token)
              return error(response, 'summary_resume_required', 400);
            state.summary_resume_tokens.push(value.resume_token);
            if (stages.resumes.has(value.resume_token))
              return send(response, job);
            if (stages.token !== value.resume_token)
              return error(response, 'summary_resume_changed', 409);
            if (job.state !== 'failed')
              return error(response, 'job_not_retryable', 409);
            stages.resumes.add(value.resume_token);
            stages.token = randomUUID();
          }
          if (job.state !== 'failed')
            return error(response, 'job_not_retryable', 409);
          const next = {
            ...job,
            state: 'queued' as const,
            attempt: 0,
            error: null,
          };
          jobs.set(id, next);
          record(document, 'job', id);
          if (job.kind === 'summary' && state.lose_summary_resume_response) {
            state.lose_summary_resume_response = false;
            response.destroy();
            return;
          }
          return send(response, next);
        }
      }
      if (
        request.method === 'POST' &&
        existing &&
        parts[4] === 'transcript' &&
        parts[5] === 'apply'
      ) {
        const value = applyTranscriptSchema.parse(body);
        if (existing.transcript_revision !== value.base_revision)
          return error(response, 'revision_conflict', 409);
        const source = transcripts.get(`${id}:${value.source_revision}`);
        if (!source) return error(response, 'transcript_not_found', 404);
        const revision =
          Math.max(
            0,
            ...[...transcripts.values()]
              .filter((entry) => entry.document_id === id)
              .map((entry) => entry.revision),
          ) + 1;
        const next = {
          ...source,
          revision,
          is_candidate: false,
          based_on_revision: value.source_revision,
        };
        transcripts.set(`${id}:${revision}`, next);
        timelines.set(
          `${id}:${revision}`,
          timelines.get(`${id}:${value.source_revision}`) ?? [],
        );
        const document = { ...existing, transcript_revision: revision };
        documents.set(id, document);
        record(document, 'transcript');
        const { segments, ...header } = next;
        const page = makeTranscriptPage(
          { ...header, total_segments: segments.length },
          0,
          segments,
        );
        replays.set(key, { hash, value: page });
        return send(response, page);
      }
      let next: Document | null;
      if (request.method === 'POST' && path === '/v1/documents') {
        const value = createDocumentSchema.parse(body);
        if (!state.workspaces.some((item) => item.id === value.workspace_id))
          return error(response, 'workspace_not_found', 404);
        if (value.id && (documents.has(value.id) || tombstones.has(value.id)))
          return error(response, 'document_id_conflict', 409);
        next = documentSchema.parse({
          ...value,
          id: value.id ?? randomUUID(),
          owner_id: user,
          revision: 1,
          transcript_revision: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } else {
        if (!existing) return error(response, 'document_not_found', 404);
        if (request.method === 'DELETE') {
          remove(id);
          next = null;
        } else if (request.method === 'PUT' && parts[4] === 'notes') {
          const value = updateNotesSchema.parse(body);
          if (value.base_revision !== existing.revision)
            return error(response, 'revision_conflict', 409);
          next = {
            ...existing,
            notes: value.notes,
            content: value.content,
            revision: existing.revision + 1,
            updated_at: new Date().toISOString(),
          };
        } else if (request.method === 'PATCH' && parts.length === 4) {
          const value = updateDocumentSchema.parse(body);
          if (value.base_revision !== existing.revision)
            return error(response, 'revision_conflict', 409);
          next = {
            ...existing,
            title: value.title ?? existing.title,
            tags: value.tags ?? existing.tags,
            revision: existing.revision + 1,
            updated_at: new Date().toISOString(),
          };
        } else throw new Error('Unexpected synthetic API request.');
      }
      if (next) {
        documents.set(next.id, next);
        record(next);
      }
      replays.set(key, { hash, value: next });
      send(response, next, next ? 200 : 204);
    })().catch((failure: unknown) => {
      state.failures.push(failure instanceof Error ? failure.name : 'unknown');
      if (!response.headersSent) error(response, 'fixture_failure', 500);
      else response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No synthetic API port.');
  return {
    issuer,
    state,
    seed,
    change,
    remove,
    transcript,
    publishCandidate,
    publishSummary,
    previewSummary,
    failSummary,
    publishChat,
    previewChat,
    failChat,
    registerRecording(
      document_id: string,
      value: {
        id: string;
        track_id: string;
        seal_sha256: string;
        partial: boolean;
      },
    ) {
      if (!documents.has(document_id))
        throw new Error('Missing synthetic recording document.');
      recordings.set(value.id, { ...value, document_id });
    },
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
      await issuer.close();
    },
  };
}
