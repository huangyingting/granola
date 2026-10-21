import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@windows-ai-notes/contracts/content';
import {
  recordingCapabilitiesSchema,
  registerChunkSchema,
  remoteChunkSchema,
  uploadAuthorizationSchema,
  type RemoteChunk,
} from '@windows-ai-notes/contracts/uploads';
import type { UploadChunk } from '@windows-ai-notes/contracts';
import { ApiClient, ClientError, serverUrl } from './http.js';

function invalid(message: string): never {
  throw new ClientError('invalid_upload_response', message);
}
function sameChunk(chunk: RemoteChunk, expected: UploadChunk) {
  if (canonicalJson(chunk.upload) !== canonicalJson(expected))
    invalid('The service changed the immutable audio chunk descriptor.');
  return chunk;
}

export class RecordingUploadTransport {
  constructor(
    private readonly api: ApiClient,
    private readonly options: { allowLoopback?: boolean } = {},
  ) {}
  async chunk(
    value: UploadChunk,
    source: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
    options: {
      authorize: () => void;
      signal?: AbortSignal;
      progress?: (bytes: number, total: number) => void;
    },
  ): Promise<RemoteChunk> {
    const upload = registerChunkSchema.parse(value);
    const { recording_id: recording, chunk_id: id } = upload.chunk;
    const signal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const check = () => {
      if (signal.aborted)
        throw new ClientError(
          'request_cancelled',
          'Audio transfer was cancelled or timed out. Local audio was preserved.',
          0,
          true,
        );
      options.authorize();
    };
    check();
    const capabilities = await this.api.request(
      '/v1/recording-capabilities',
      recordingCapabilitiesSchema,
      { signal },
    );
    check();
    if (!capabilities.enabled || !capabilities.upload_origin)
      throw new ClientError(
        'storage_not_configured',
        'The service has not enabled private audio storage.',
        503,
      );
    const origin = serverUrl(
      capabilities.upload_origin,
      this.options.allowLoopback,
    );
    const registered = sameChunk(
      await this.api.request(
        `/v1/recordings/${recording}/chunks`,
        remoteChunkSchema,
        { method: 'POST', body: upload, key: `chunk:${id}`, signal },
      ),
      upload,
    );
    check();
    if (registered.state === 'verified') return registered;
    const authorization = await this.api.request(
      `/v1/audio-chunks/${id}/upload`,
      uploadAuthorizationSchema,
      { method: 'POST', body: {}, key: randomUUID(), signal },
    );
    check();
    if (!authorization.upload) {
      const current = sameChunk(
        await this.api.request(`/v1/audio-chunks/${id}`, remoteChunkSchema, {
          signal,
        }),
        upload,
      );
      check();
      if (current.state !== 'verified')
        invalid(
          'The service did not confirm that the audio chunk was verified.',
        );
      return current;
    }
    const grant = authorization.upload;
    const destination = new URL(grant.url);
    const path = new RegExp(
      `^/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/recordings/v1/staging/${grant.id}$`,
    );
    if (
      destination.origin !== origin ||
      destination.username ||
      destination.password ||
      destination.hash ||
      !path.test(destination.pathname) ||
      !destination.searchParams.has('X-Amz-Signature') ||
      destination.searchParams.get('X-Amz-Expires') !== '300' ||
      Date.parse(grant.expires_at) <= Date.now() ||
      grant.headers['content-length'] !== String(upload.size_bytes) ||
      grant.headers['x-amz-checksum-sha256'] !==
        Buffer.from(upload.sha256, 'hex').toString('base64')
    )
      invalid(
        'The service returned an unsupported audio upload destination or checksum binding.',
      );
    const bytes = Buffer.alloc(upload.size_bytes);
    try {
      let offset = 0;
      for await (const part of source(signal)) {
        check();
        if (offset + part.byteLength > bytes.length)
          throw new ClientError(
            'audio_checksum_mismatch',
            'The native audio stream exceeded its immutable declared size.',
          );
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      check();
      if (
        offset !== bytes.length ||
        createHash('sha256').update(bytes).digest('hex') !== upload.sha256
      )
        throw new ClientError(
          'audio_checksum_mismatch',
          'The native audio stream did not match its immutable declared size and checksum.',
        );
      const headers = new Headers();
      for (const [name, value] of Object.entries(grant.headers))
        if (value !== undefined) headers.set(name, value);
      let response: Response;
      try {
        response = await fetch(destination, {
          method: 'PUT',
          headers,
          body: new Uint8Array(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ),
          signal,
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
        });
      } catch {
        throw new ClientError(
          'audio_upload_unavailable',
          'Audio transfer did not complete. Local audio was preserved; retry to reconcile remote state.',
          0,
          true,
        );
      }
      await response.body?.cancel();
      check();
      if (!response.ok)
        throw new ClientError(
          response.status >= 300 && response.status < 400
            ? 'audio_upload_redirect_rejected'
            : 'audio_upload_failed',
          'Private audio storage did not accept the upload. Local audio was preserved.',
          response.status,
          true,
        );
      const completed = sameChunk(
        await this.api.request(
          `/v1/audio-chunks/${id}/complete`,
          remoteChunkSchema,
          {
            method: 'POST',
            body: { upload_id: grant.id },
            key: `complete:${grant.id}`,
            signal,
          },
        ),
        upload,
      );
      check();
      if (completed.state !== 'verified')
        invalid(
          'The service did not verify the uploaded audio. Keep the local recording.',
        );
      options.progress?.(bytes.length, bytes.length);
      return completed;
    } finally {
      bytes.fill(0);
    }
  }
}
