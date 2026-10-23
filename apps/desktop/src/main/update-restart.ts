import { createConnection, type Socket } from 'node:net';
import { FrameDecoder, encodeJsonFrame } from '@windows-ai-notes/contracts';
import {
  updateRestartChallengeSchema,
  updateRestartConfirmedSchema,
  updateRestartReadySchema,
} from '@windows-ai-notes/contracts/updates';
import { LocalError } from '@windows-ai-notes/local';
import type { z } from 'zod';
import { acquireStartupAdmission } from './update-startup.js';

type Binding = z.infer<typeof updateRestartChallengeSchema>;
export interface RestartArguments {
  session: string;
  health: string;
  authentication: string;
}
export interface RestartStartup {
  confirm(storageSchema: number): Promise<void>;
  close(): void;
}

export function restartArguments(
  argv: readonly string[],
): RestartArguments | null {
  const keys = ['--update-restart=', '--update-health=', '--update-auth='];
  const args = argv.filter((value) => value.startsWith('--update-'));
  if (args.length === 0) return null;
  const values = keys.map((key) =>
    args.filter((value) => value.startsWith(key)),
  );
  const session = values[0]?.[0]?.slice(keys[0]!.length);
  const health = values[1]?.[0]?.slice(keys[1]!.length);
  const authentication = values[2]?.[0]?.slice(keys[2]!.length);
  if (
    args.length !== 3 ||
    values.some((value) => value.length !== 1) ||
    !session ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      session,
    ) ||
    !health ||
    !authentication ||
    !validEndpoint(health, session, 'Restart') ||
    !validEndpoint(authentication, session, 'RestartAuth')
  )
    throw new LocalError(
      'update_restart_arguments',
      'Restart startup arguments are incomplete or invalid. Local data was not opened.',
    );
  return { session, health, authentication };
}

function validEndpoint(endpoint: string, session: string, kind: string) {
  const prefix = `WindowsAINotes.${kind}.${session.replaceAll('-', '')}.`;
  return (
    endpoint.startsWith(prefix) &&
    /^[0-9a-f]{64}$/u.test(endpoint.slice(prefix.length))
  );
}

export async function acquireRestartStartup(
  helper: string,
  application: string,
  version: string,
  args: RestartArguments,
): Promise<RestartStartup> {
  const session = new RestartSession(version, args);
  try {
    const binding = await session.challenge;
    await acquireStartupAdmission(
      helper,
      application,
      version,
      { binding, endpoint: args.authentication },
      session.abort.signal,
    );
    session.admitted();
    return session;
  } catch (error) {
    const failure = session.failure;
    session.close();
    throw failure ?? error;
  }
}

class RestartSession implements RestartStartup {
  readonly abort = new AbortController();
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly timer: ReturnType<typeof setTimeout>;
  private binding: Binding | null = null;
  private phase:
    | 'challenge'
    | 'authenticating'
    | 'admitted'
    | 'confirming'
    | 'acknowledged'
    | 'closed' = 'challenge';
  failure: LocalError | null = null;
  private bytes = 0;
  private resolveChallenge!: (binding: Binding) => void;
  private rejectChallenge!: (error: LocalError) => void;
  readonly challenge = new Promise<Binding>((resolve, reject) => {
    this.resolveChallenge = resolve;
    this.rejectChallenge = reject;
  });
  private resolveConfirmation: (() => void) | null = null;
  private rejectConfirmation: ((error: LocalError) => void) | null = null;

  constructor(
    private readonly version: string,
    private readonly args: RestartArguments,
  ) {
    this.socket = createConnection(`\\\\.\\pipe\\${args.health}`);
    this.timer = setTimeout(() => this.fail('update_restart_timeout'), 90_000);
    this.socket.on('error', () => this.fail('update_restart_transport'));
    this.socket.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
      try {
        if (this.bytes > 4096) throw new Error('Restart byte bound exceeded.');
        for (const frame of this.decoder.push(chunk)) {
          if (this.phase === 'challenge') {
            const binding = updateRestartChallengeSchema.parse(frame);
            if (
              binding.identity.pid !== process.pid ||
              binding.session_id !== args.session ||
              binding.application_version !== version
            )
              throw new Error('Invalid restart identity.');
            this.binding = binding;
            this.phase = 'authenticating';
            this.resolveChallenge(binding);
          } else if (this.phase === 'confirming' && this.binding) {
            const confirmation = updateRestartConfirmedSchema.parse(frame);
            if (
              confirmation.session_id !== this.binding.session_id ||
              confirmation.challenge !== this.binding.challenge ||
              confirmation.identity.pid !== this.binding.identity.pid ||
              confirmation.identity.creation_file_time !==
                this.binding.identity.creation_file_time ||
              confirmation.application_version !==
                this.binding.application_version
            )
              throw new Error('Unbound restart health.');
            this.phase = 'acknowledged';
          } else throw new Error('Unexpected restart frame.');
        }
      } catch {
        this.fail('update_restart_protocol');
      }
    });
    this.socket.once('close', () => {
      clearTimeout(this.timer);
      try {
        this.decoder.finish();
      } catch {
        this.fail('update_restart_protocol');
      }
      if (this.phase === 'acknowledged' && !this.failure) {
        this.phase = 'closed';
        this.resolveConfirmation?.();
      } else this.fail('update_restart_closed');
    });
  }

  admitted() {
    if (this.failure) throw this.failure;
    if (this.phase !== 'authenticating')
      throw this.error('update_restart_protocol');
    this.phase = 'admitted';
  }

  confirm(storageSchema: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.phase !== 'admitted' || !this.binding)
      return Promise.reject(this.error('update_restart_used'));
    const ready = updateRestartReadySchema.safeParse({
      ...this.binding,
      event: 'update_restart_ready',
      storage_schema: storageSchema,
    });
    if (!ready.success) {
      this.fail('update_restart_schema');
      return Promise.reject(this.failure);
    }
    this.phase = 'confirming';
    const confirmed = new Promise<void>((resolve, reject) => {
      this.resolveConfirmation = resolve;
      this.rejectConfirmation = reject;
    });
    this.socket.write(encodeJsonFrame(ready.data));
    return confirmed;
  }

  close() {
    if (this.phase !== 'closed') this.fail('update_restart_cancelled');
    this.socket.destroy();
    clearTimeout(this.timer);
  }

  private error(code: string) {
    return new LocalError(
      code,
      'Restart startup could not be confirmed. Existing local data was preserved; no installer was retried and no backup was restored.',
    );
  }

  private fail(code: string) {
    this.failure ??= this.error(code);
    this.abort.abort();
    this.rejectChallenge(this.failure);
    this.rejectConfirmation?.(this.failure);
    this.socket.destroy();
    clearTimeout(this.timer);
  }
}
