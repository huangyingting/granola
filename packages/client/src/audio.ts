import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  audioEventSchema,
  audioRequestSchema,
  encodeFrame,
  FrameDecoder,
  MAX_AUDIO_RANGE_BYTES,
  uploadChunkSchema,
  type AudioEvent,
  type AudioRequest,
  type UploadChunk,
} from '@windows-ai-notes/contracts';
import { canonicalJson } from '@windows-ai-notes/contracts/content';

const expectedEvents: Record<
  AudioRequest['command'],
  AudioEvent['event_type']
> = {
  list_devices: 'devices',
  start_recording: 'recording.started',
  pause_recording: 'recording.paused',
  resume_recording: 'recording.resumed',
  stop_recording: 'recording.stopped',
  inspect_recording: 'recording.inspected',
  get_recording: 'recording.manifest',
  list_recording_chunks: 'recording.chunks',
  read_chunk: 'recording.chunk_range',
};

type RequestFields<T = AudioRequest> = T extends AudioRequest
  ? Omit<T, 'protocol_version' | 'request_id'>
  : never;

export class AudioHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AudioHostError';
  }
}

export class AudioHostClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      request: AudioRequest;
      resolve: (event: AudioEvent) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly decoder = new FrameDecoder();
  private readonly exited: Promise<number | null>;
  private closing = false;
  private fatalError: Error | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private rejectFailure!: (error: Error) => void;
  readonly failure = new Promise<never>((_, reject) => {
    this.rejectFailure = reject;
  });

  constructor(
    executable: string,
    args: string[],
    onEvent: (event: AudioEvent) => void,
  ) {
    this.failure.catch(() => undefined);
    this.child = spawn(executable, args, { stdio: 'pipe', windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.once('error', (error) => {
        this.fail(error);
        resolve(null);
      });
      this.child.once('close', (code) => {
        try {
          this.decoder.finish();
        } catch (error) {
          this.fail(asError(error));
        }
        if (!this.closing || code !== 0) {
          this.fail(
            new Error(
              `AudioHost exited with code ${code ?? 'unknown'}. Inspect saved audio before assuming it is complete.`,
            ),
          );
        }
        if (this.killTimer) clearTimeout(this.killTimer);
        resolve(code);
      });
    });
    this.child.stderr.on('data', (bytes: Buffer) =>
      process.stderr.write(bytes),
    );
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (bytes: Buffer) => {
      if (this.fatalError) return;
      try {
        for (const message of this.decoder.push(bytes)) {
          const event = audioEventSchema.parse(message);
          const handler =
            event.request_id === null
              ? undefined
              : this.pending.get(event.request_id);
          if (event.request_id !== null && !handler)
            throw new Error('AudioHost replied to an unknown request.');
          if (
            handler &&
            (event.recording_id !==
              ('recording_id' in handler.request
                ? handler.request.recording_id
                : null) ||
              (event.event_type !== 'error' &&
                event.event_type !== expectedEvents[handler.request.command]))
          )
            throw new Error(
              'AudioHost replied with a different recording or response type.',
            );
          // Media belongs only to the awaiting reader, never status/UI observers.
          if (event.event_type !== 'recording.chunk_range') onEvent(event);
          if (handler && event.request_id !== null) {
            this.pending.delete(event.request_id);
            if (event.event_type === 'error') {
              handler.reject(
                new AudioHostError(
                  event.payload.code,
                  event.payload.message,
                  event.payload.retryable,
                ),
              );
            } else {
              handler.resolve(event);
            }
          } else if (event.event_type === 'error') {
            this.fail(
              new AudioHostError(
                event.payload.code,
                event.payload.message,
                event.payload.retryable,
              ),
            );
            return;
          }
        }
      } catch (error) {
        this.fail(asError(error));
      }
    });
  }

  async request(fields: RequestFields): Promise<AudioEvent> {
    if (this.fatalError) throw this.fatalError;
    if (this.closing)
      throw new Error('AudioHost is closing; no new requests are accepted.');
    if (this.pending.size >= 8 || this.child.stdin.writableNeedDrain)
      throw new Error(
        'AudioHost is busy. Retry after an outstanding request completes.',
      );
    const request = audioRequestSchema.parse({
      ...fields,
      protocol_version: 1,
      request_id: randomUUID(),
    });
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<AudioEvent>((resolve, reject) => {
      this.pending.set(request.request_id, { request, resolve, reject });
      timer = setTimeout(() => {
        this.fail(
          new Error(
            'AudioHost did not respond within 30 seconds. Inspect the recording before assuming capture completed.',
          ),
        );
      }, 30_000);
    });
    this.child.stdin.write(encodeFrame(request));
    try {
      return await Promise.race([response, this.failure]);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(request.request_id);
    }
  }

  async *readChunk(
    recording: string,
    descriptor: UploadChunk,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const upload = uploadChunkSchema.parse(descriptor);
    if (upload.chunk.recording_id !== recording)
      throw new Error('This upload chunk belongs to a different recording.');
    const identity = canonicalJson(upload);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < upload.size_bytes) {
      if (signal?.aborted)
        throw new Error('Audio chunk streaming was cancelled.');
      const length = Math.min(
        MAX_AUDIO_RANGE_BYTES,
        upload.size_bytes - offset,
      );
      const event = await this.request({
        command: 'read_chunk',
        recording_id: recording,
        chunk_id: upload.chunk.chunk_id,
        offset,
        length,
      });
      if (signal?.aborted)
        throw new Error('Audio chunk streaming was cancelled.');
      if (event.event_type !== 'recording.chunk_range')
        throw new Error('AudioHost did not return a chunk range.');
      const range = event.payload;
      const bytes = Buffer.from(range.data_base64, 'base64');
      if (
        canonicalJson(range.upload) !== identity ||
        range.offset !== offset ||
        bytes.length !== length ||
        bytes.toString('base64') !== range.data_base64
      ) {
        const error = new Error(
          'AudioHost returned inconsistent or changed chunk range metadata.',
        );
        this.fail(error);
        throw error;
      }
      hash.update(bytes);
      offset += bytes.length;
      yield bytes;
    }
    if (hash.digest('hex') !== upload.sha256) {
      const error = new Error(
        'The streamed canonical WAV checksum does not match the verified upload descriptor.',
      );
      this.fail(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.child.kill();
            reject(
              new Error(
                'AudioHost did not stop after EOF. Inspect the recording for an unsealed tail.',
              ),
            );
          }, 15_000);
        }),
      ]);
      if (this.fatalError) throw this.fatalError;
      if (code !== 0)
        throw new Error(`AudioHost did not exit successfully (${code}).`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError ??= error;
    this.rejectFailure(error);
    for (const handler of this.pending.values()) handler.reject(error);
    this.pending.clear();
    if (!this.child.stdin.writableEnded && !this.child.stdin.destroyed)
      this.child.stdin.end();
    this.killTimer = setTimeout(() => this.child.kill(), 15_000);
    this.killTimer.unref();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
