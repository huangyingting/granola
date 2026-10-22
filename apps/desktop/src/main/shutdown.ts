import { PendingWork } from '@windows-ai-notes/client/lifecycle';
import { LocalError } from '@windows-ai-notes/local';

export class DesktopShutdown {
  private readonly commands = new PendingWork();
  private closing = false;
  private finished = false;
  private active: Promise<void> | null = null;

  constructor(
    private readonly services: {
      cancel: () => void;
      drain: () => Promise<void>;
      release: () => void;
    },
  ) {}

  get complete() {
    return this.finished;
  }

  assertOpen() {
    if (this.closing)
      throw new LocalError(
        'desktop_closing',
        'The application is closing safely. Wait or retry closing; your saved notes were preserved.',
      );
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.commands.track(operation());
  }

  close(): Promise<void> {
    if (this.finished) return Promise.resolve();
    if (this.active) return this.active;
    this.closing = true;
    this.active = Promise.resolve()
      .then(async () => {
        this.services.cancel();
        await this.commands.drain();
        await this.services.drain();
        this.services.release();
        this.finished = true;
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }
}
