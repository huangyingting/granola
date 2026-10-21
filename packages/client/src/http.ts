import { z } from 'zod';
import {
  documentSchema,
  jobSchema,
  transcriptSchema,
  transcriptPageSchema,
  transcriptPageQuerySchema,
  resourceId,
  syncChangesSchema,
  syncSnapshotSchema,
} from '@windows-ai-notes/contracts/server';
import type { Mutation } from '@windows-ai-notes/local';

export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly retryable = false,
    readonly retryAfterSeconds = 0,
    readonly purgeWorkspaceId?: string,
  ) {
    super(message);
  }
}
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
        const header = response.headers.get('retry-after');
        const seconds = header ? Number(header) : 0;
        throw new ClientError(
          body.code,
          body.message,
          response.status,
          body.retryable,
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(300, seconds)
            : response.status === 429
              ? 30
              : 0,
          body.purge_workspace_id,
        );
      }
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
  identity(signal?: AbortSignal) {
    return this.request(
      '/v1/me',
      z.strictObject({ id: resourceId }),
      signal ? { signal } : {},
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
