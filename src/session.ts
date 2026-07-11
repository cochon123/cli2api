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
    if (Buffer.byteLength(key) > 512) return undefined;
    const record = this.records.get(key);
    if (!record) return undefined;
    if (Date.now() - record.touchedAt > this.ttlMs) {
      this.records.delete(key);
      return undefined;
    }
    // A lookup through another adapter must not destroy the original mapping.
    if (record.adapter !== adapter) return undefined;
    record.touchedAt = Date.now();
    return record.nativeId;
  }

  /** Atomically move a response-id mapping so native transcripts stay linear. */
  move(from: string | undefined, to: string | undefined, adapter: string): string | undefined {
    const value = this.get(from, adapter);
    if (!value || !from || !to) return undefined;
    this.records.delete(from);
    this.set(to, adapter, value);
    return value;
  }

  delete(key: string | undefined): void {
    if (key) this.records.delete(key);
  }

  set(key: string | undefined, adapter: string, nativeId: string): void {
    if (!key || !nativeId) return;
    if (Buffer.byteLength(key) > 512 || Buffer.byteLength(nativeId) > 4_096) return;
    this.records.delete(key);
    this.records.set(key, { adapter, nativeId, touchedAt: Date.now() });
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }
}
