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
