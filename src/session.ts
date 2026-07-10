interface SessionRecord {
  adapter: string;
  nativeId: string;
  touchedAt: number;
}

/** In-memory mapping only; native CLI transcripts remain owned by each CLI. */
export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  constructor(
    private readonly maxEntries = 1_000,
    private readonly ttlMs = 24 * 60 * 60 * 1_000,
  ) {}

  get(key: string | undefined, adapter: string): string | undefined {
    if (!key) return undefined;
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.adapter !== adapter || Date.now() - record.touchedAt > this.ttlMs) {
      this.records.delete(key);
      return undefined;
    }
    record.touchedAt = Date.now();
    return record.nativeId;
  }

  set(key: string | undefined, adapter: string, nativeId: string): void {
    if (!key || !nativeId) return;
    this.records.delete(key);
    this.records.set(key, { adapter, nativeId, touchedAt: Date.now() });
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }
}
