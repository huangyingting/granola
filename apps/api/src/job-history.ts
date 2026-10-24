type Receipt = Readonly<{ source: string; etag: string }>;

export class JobHistoryReceipts {
  private readonly entries = new Map<string, Receipt>();

  get(key: string): Receipt | undefined {
    const receipt = this.entries.get(key);
    if (receipt) {
      this.entries.delete(key);
      this.entries.set(key, receipt);
    }
    return receipt;
  }

  remember(key: string, source: string, etag: string) {
    this.entries.delete(key);
    if (this.entries.size >= 256) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, Object.freeze({ source, etag }));
  }

  clear() {
    this.entries.clear();
  }
}
