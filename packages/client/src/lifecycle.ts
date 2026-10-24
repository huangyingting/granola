// Cancelling this wait does not cancel the operation or retire its owner.
export async function cancellableWait<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  cancelled: () => Error,
): Promise<T> {
  if (signal.aborted) throw cancelled();
  let abort!: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(cancelled());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      operation().then((value) => {
        if (signal.aborted) abort();
        else resolve(value);
      }, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class PendingWork {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  async drain(): Promise<void> {
    // Owners handle operation failures; shutdown waits for completion, not success.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
