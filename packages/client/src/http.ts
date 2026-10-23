import { z } from 'zod';
import {
  documentSchema,
  jobSchema,
  jobEventSchema,
  transcriptSchema,
  transcriptPageSchema,
  transcriptPageQuerySchema,
  transcriptTimelinePageSchema,
  finalizeTranscriptSchema,
  resourceId,
  syncChangesSchema,
  syncSnapshotSchema,
} from '@windows-ai-notes/contracts/server';
import type { Mutation } from '@windows-ai-notes/local';
import { ClientError } from './errors.js';
import { openLiveConnection, type LiveConnectionOptions } from './live.js';
import { SseDecoder, SseDecodeError } from '@windows-ai-notes/contracts/sse';
import { chatEventSchema } from '@windows-ai-notes/contracts/questions';
export { ClientError } from './errors.js';
export function serverUrl(value: string, allowLoopback = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError(
      'invalid_service_url',
      'Enter a valid HTTPS service URL.',
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        allowLoopback &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new ClientError(
      'invalid_service_url',
      'Use an HTTPS service origin without credentials, query parameters or a path.',
    );
  return url.origin;
}
const errorSchema = z.strictObject({
  code: z.string().regex(/^[a-z_]{1,100}$/),
  message: z.string().max(1000),
  retryable: z.boolean(),
  request_id: z.string().max(100),
  current_revision: z.number().int().optional(),
  reset_required: z.boolean().optional(),
  purge_workspace_id: resourceId.optional(),
});
export async function responseJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  maximum = 16 * 1024 * 1024,
): Promise<T> {
  if (!response.body)
    throw new ClientError(
      'invalid_server_response',
      'The service response is empty.',
      response.status,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximum)
        throw new ClientError(
          'response_too_large',
          'The service response exceeds the supported size.',
          response.status,
        );
      chunks.push(chunk.value);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ClientError(
        'invalid_server_response',
        'The service did not return valid JSON.',
        response.status,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ClientError(
        'invalid_server_response',
        'The service returned an unsupported response.',
        response.status,
      );
    return parsed.data;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
function httpDate(value: string, now: number): number {
  let date = value.replace(
    /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/,
    (
      _match,
      name: string,
      month: string,
      day: string,
      time: string,
      year: string,
    ) => `${name}, ${day.trim().padStart(2, '0')} ${month} ${year} ${time} GMT`,
  );
  const leap = date.endsWith(':60 GMT');
  if (leap) date = date.replace(/:60 GMT$/, ':59 GMT');
  date = date.replace(
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/,
    (
      _match,
      name: string,
      day: string,
      month: string,
      year: string,
      time: string,
    ) => {
      // RFC 850 uses a rolling 50-year window, not Date.parse's fixed pivot.
      const limit = new Date(now);
      limit.setUTCFullYear(limit.getUTCFullYear() + 50);
      const fullYear =
        Math.floor(limit.getUTCFullYear() / 100) * 100 + Number(year);
      const withYear = (value: number) =>
        `${name.slice(0, 3)}, ${day} ${month} ${String(value).padStart(4, '0')} ${time} GMT`;
      const candidate = withYear(fullYear);
      return Date.parse(candidate) + (leap ? 1000 : 0) > limit.getTime()
        ? withYear(fullYear - 100)
        : candidate;
    },
  );
  if (
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      date,
    )
  )
    return NaN;
  const instant = Date.parse(date);
  return Number.isFinite(instant) && new Date(instant).toUTCString() === date
    ? instant + (leap ? 1000 : 0)
    : NaN;
}
function retryAfterSeconds(response: Response): number {
  const value = response.headers.get('retry-after') ?? '';
  const seconds = Number(value);
  const fallback = response.status === 429 ? 30 : 0;
  if (Number.isFinite(seconds))
    return seconds > 0 ? Math.min(300, seconds) : fallback;
  const now = Date.now();
  const until = httpDate(value, now);
  return Number.isFinite(until)
    ? Math.min(300, Math.max(0, (until - now) / 1000))
    : fallback;
}
async function checkResponse(response: Response) {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ClientError(
      'service_redirect_rejected',
      'The service redirected the request. Credentials were not forwarded.',
      response.status,
    );
  }
  if (!response.ok) {
    const body = await responseJson(response, errorSchema, 16_384);
    throw new ClientError(
      body.code,
      body.message,
      response.status,
      body.retryable,
      retryAfterSeconds(response),
      body.purge_workspace_id,
    );
  }
}
export class ApiClient {
  readonly base: string;
  constructor(
    base: string,
    private readonly headers: () => Promise<Record<string, string>>,
    options: { allowLoopback?: boolean } = {},
  ) {
    this.base = serverUrl(base, options.allowLoopback);
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      key?: string;
      signal?: AbortSignal;
      empty?: boolean;
    } = {},
  ): Promise<T> {
    const destination = new URL(path, this.base);
    if (
      !path.startsWith('/v1/') ||
      destination.origin !== this.base ||
      !destination.pathname.startsWith('/v1/')
    )
      throw new ClientError(
        'invalid_api_path',
        'The service request path is invalid.',
      );
    const signal = AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const headers = await this.headers();
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          ...headers,
          Accept: 'application/json',
          ...(options.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal,
        redirect: 'manual',
        cache: 'no-store',
      });
      await checkResponse(response);
      if (options.empty) {
        if (response.status !== 204) {
          await response.body?.cancel();
          throw new ClientError(
            'invalid_server_response',
            'The service did not acknowledge deletion.',
            response.status,
          );
        }
        return schema.parse(null);
      }
      return await responseJson(response, schema);
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'The service request was cancelled or timed out.',
          0,
          true,
        );
      throw new ClientError(
        'service_unavailable',
        'The service could not be reached. Local changes were preserved.',
        0,
        true,
      );
    }
  }
  async events(
    id: string,
    after: number,
    received: (event: z.infer<typeof jobEventSchema>) => Promise<void>,
    signal: AbortSignal,
  ) {
    resourceId.parse(id);
    return this.eventStream(
      `/v1/jobs/${id}/events`,
      jobEventSchema,
      (event) => event.job_id === id,
      after,
      received,
      signal,
    );
  }
  async chatEvents(
    id: string,
    after: number,
    received: (event: z.infer<typeof chatEventSchema>) => Promise<void>,
    signal: AbortSignal,
  ) {
    resourceId.parse(id);
    return this.eventStream(
      `/v1/chat-turns/${id}/events`,
      chatEventSchema,
      (event) => event.turn_id === id,
      after,
      received,
      signal,
    );
  }
  private async eventStream<T extends { seq: number; event_type: string }>(
    path: string,
    schema: z.ZodType<T>,
    matches: (event: T) => boolean,
    after: number,
    received: (event: T) => Promise<void>,
    signal: AbortSignal,
  ) {
    z.number().int().min(0).max(2_147_483_647).parse(after);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = await this.headers();
      bounded.throwIfAborted();
      const response = await fetch(`${this.base}${path}`, {
        headers: {
          ...headers,
          Accept: 'text/event-stream',
          'Last-Event-ID': String(after),
        },
        redirect: 'manual',
        cache: 'no-store',
        signal: bounded,
      });
      await checkResponse(response);
      if (
        !response.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('text/event-stream') ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new ClientError(
          'invalid_event_stream',
          'The service did not return a generation event stream.',
        );
      }
      reader = response.body.getReader();
      const decoder = new SseDecoder(2 * 1024 * 1024);
      let bytes = 0,
        count = 0;
      while (true) {
        bounded.throwIfAborted();
        const part = await reader.read();
        let frames;
        try {
          frames = part.done ? decoder.finish() : decoder.push(part.value);
        } catch (error) {
          if (
            part.done &&
            ((error instanceof SseDecodeError && error.code === 'incomplete') ||
              error instanceof TypeError)
          )
            throw new ClientError(
              'event_stream_interrupted',
              'Generation updates ended mid-event. Replaying from the last saved cursor.',
              0,
              true,
            );
          throw new ClientError(
            'invalid_event_stream',
            'The service returned invalid or oversized event framing.',
          );
        }
        if (!part.done) bytes += part.value.length;
        if (bytes > 4 * 1024 * 1024) return after;
        for (const frame of frames) {
          let value: unknown;
          try {
            value = JSON.parse(frame.data) as unknown;
          } catch {
            throw new ClientError(
              'invalid_event_stream',
              'The service returned an invalid event.',
            );
          }
          const parsed = schema.safeParse(value);
          if (
            !parsed.success ||
            !matches(parsed.data) ||
            parsed.data.seq !== after + 1 ||
            frame.id !== String(parsed.data.seq) ||
            frame.event !== parsed.data.event_type
          )
            throw new ClientError(
              'invalid_event_stream',
              'The event does not match its authorized operation, sequence or schema.',
            );
          signal.throwIfAborted();
          await received(parsed.data);
          after = parsed.data.seq;
          if (++count === 512) return after;
        }
        if (part.done) return after;
      }
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'Generation updates were stopped.',
        );
      if (bounded.aborted)
        throw new ClientError(
          'event_connection_expired',
          'Renewing generation updates.',
          0,
          true,
        );
      throw new ClientError(
        'service_unavailable',
        'Generation updates were interrupted. Saved progress was preserved.',
        0,
        true,
      );
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    }
  }
  identity(signal?: AbortSignal) {
    return this.request(
      '/v1/me',
      z.strictObject({ id: resourceId }),
      signal ? { signal } : {},
    );
  }
  openLiveSource(id: string, options: LiveConnectionOptions) {
    return openLiveConnection(
      this.base,
      resourceId.parse(id),
      this.headers,
      options,
    );
  }
  workspaces(signal?: AbortSignal) {
    return this.request(
      '/v1/workspaces',
      z.strictObject({
        workspaces: z.array(
          z.strictObject({ id: resourceId, name: z.string().max(200) }),
        ),
      }),
      signal ? { signal } : {},
    );
  }
  document(id: string, signal?: AbortSignal) {
    return this.request(
      `/v1/documents/${resourceId.parse(id)}`,
      documentSchema,
      signal ? { signal } : {},
    );
  }
  snapshot(
    workspace: string,
    progress: { cursor: string | null; after: string | null },
    signal: AbortSignal,
  ) {
    const query = new URLSearchParams({
      workspace_id: resourceId.parse(workspace),
      limit: '10',
    });
    if (progress.cursor) query.set('cursor', progress.cursor);
    if (progress.after) query.set('after', progress.after);
    return this.request(`/v1/sync/snapshot?${query}`, syncSnapshotSchema, {
      signal,
    });
  }
  changes(workspace: string, cursor: string, signal: AbortSignal) {
    const query = new URLSearchParams({
      workspace_id: resourceId.parse(workspace),
      cursor,
      limit: '10',
    });
    return this.request(`/v1/sync/changes?${query}`, syncChangesSchema, {
      signal,
    });
  }
  transcript(id: string, revision: number, signal: AbortSignal) {
    return this.request(
      `/v1/documents/${resourceId.parse(id)}/transcript?revision=${z.number().int().positive().parse(revision)}`,
      transcriptSchema,
      { signal },
    );
  }
  async transcriptPage(
    id: string,
    revision: number,
    offset: number,
    signal: AbortSignal,
  ) {
    const query = transcriptPageQuerySchema.parse({ revision, offset });
    const page = await this.request(
      `/v1/documents/${resourceId.parse(id)}/transcript/pages?revision=${query.revision}&offset=${query.offset}`,
      transcriptPageSchema,
      { signal },
    );
    if (
      page.document_id !== id ||
      page.revision !== revision ||
      page.offset !== offset
    )
      throw new ClientError(
        'invalid_server_response',
        'The service returned an inconsistent transcript page.',
      );
    return page;
  }
  async transcriptTimeline(
    id: string,
    revision: number,
    offset: number,
    signal: AbortSignal,
  ) {
    const page = await this.request(
      `/v1/documents/${resourceId.parse(id)}/transcript/timeline?revision=${z.number().int().positive().parse(revision)}&offset=${z.number().int().min(0).max(20_000).parse(offset)}`,
      transcriptTimelinePageSchema,
      { signal },
    );
    if (
      page.document_id !== id ||
      page.revision !== revision ||
      page.offset !== offset
    )
      throw new ClientError(
        'invalid_server_response',
        'The service returned an inconsistent capture timeline.',
      );
    return page;
  }
  finalizeRecording(
    id: string,
    body: z.infer<typeof finalizeTranscriptSchema>,
    key: string,
    signal: AbortSignal,
  ) {
    return this.request(
      `/v1/recordings/${resourceId.parse(id)}/finalize-transcript`,
      jobSchema,
      {
        method: 'POST',
        body: finalizeTranscriptSchema.parse(body),
        key,
        signal,
      },
    );
  }
  jobs(id: string, signal: AbortSignal) {
    return this.request(
      `/v1/documents/${resourceId.parse(id)}/jobs?limit=20`,
      z.strictObject({ jobs: z.array(jobSchema).max(20) }),
      { signal },
    );
  }
  mutation(mutation: Mutation, signal: AbortSignal) {
    const path =
      mutation.kind === 'create'
        ? '/v1/documents'
        : `/v1/documents/${resourceId.parse(mutation.document_id)}${mutation.kind === 'notes' ? '/notes' : ''}`;
    const method =
      mutation.kind === 'create'
        ? 'POST'
        : mutation.kind === 'notes'
          ? 'PUT'
          : mutation.kind === 'metadata'
            ? 'PATCH'
            : 'DELETE';
    if (mutation.kind === 'delete')
      return this.request(path, z.null(), {
        method,
        key: mutation.id,
        signal,
        empty: true,
      });
    return this.request(path, documentSchema, {
      method,
      key: mutation.id,
      body: mutation.body,
      signal,
    });
  }
}
