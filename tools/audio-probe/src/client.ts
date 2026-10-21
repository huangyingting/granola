import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  audioEventSchema,
  audioRequestSchema,
  encodeFrame,
  FrameDecoder,
  type AudioEvent,
  type AudioRequest,
} from '@windows-ai-notes/contracts';

type RequestFields<T = AudioRequest> = T extends AudioRequest
  ? Omit<T, 'protocol_version' | 'request_id'>
  : never;

export class AudioHostClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (event: AudioEvent) => void; reject: (error: Error) => void }
  >();
  private readonly decoder = new FrameDecoder();
  private readonly exited: Promise<number | null>;
  private closing = false;
  private fatalError: Error | undefined;
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
        resolve(code);
      });
    });
    this.child.stderr.on('data', (bytes: Buffer) =>
      process.stderr.write(bytes),
    );
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (bytes: Buffer) => {
      try {
        for (const message of this.decoder.push(bytes)) {
          const event = audioEventSchema.parse(message);
          onEvent(event);
          const handler =
            event.request_id === null
              ? undefined
              : this.pending.get(event.request_id);
          if (handler && event.request_id !== null) {
            this.pending.delete(event.request_id);
            if (event.event_type === 'error') {
              handler.reject(
                new Error(`${event.payload.code}: ${event.payload.message}`),
              );
            } else {
              handler.resolve(event);
            }
          } else if (event.event_type === 'error') {
            this.fail(
              new Error(`${event.payload.code}: ${event.payload.message}`),
            );
          }
        }
      } catch (error) {
        this.fail(asError(error));
      }
    });
  }

  async request(fields: RequestFields): Promise<AudioEvent> {
    if (this.fatalError) throw this.fatalError;
    const request = audioRequestSchema.parse({
      ...fields,
      protocol_version: 1,
      request_id: randomUUID(),
    });
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<AudioEvent>((resolve, reject) => {
      this.pending.set(request.request_id, { resolve, reject });
      timer = setTimeout(() => {
        this.pending.delete(request.request_id);
        reject(new Error('AudioHost did not respond within 30 seconds.'));
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
    this.fatalError ??= error;
    this.rejectFailure(error);
    for (const handler of this.pending.values()) handler.reject(error);
    this.pending.clear();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
