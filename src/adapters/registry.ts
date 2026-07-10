import type { Adapter } from "./types.js";
import { createMockAdapter } from "./mock.js";
import { createCodexAdapter, type CodexAdapterOptions } from "./codex.js";

export type AdapterId = "mock" | "codex";

export interface CreateRegistryOptions {
  defaultAdapter?: AdapterId;
  codex?: CodexAdapterOptions;
}

export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();
  readonly defaultAdapterId: string;

  constructor(opts: CreateRegistryOptions = {}) {
    this.defaultAdapterId = opts.defaultAdapter ?? "mock";
    this.register(createMockAdapter());
    this.register(createCodexAdapter(opts.codex));
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): Adapter | undefined {
    return this.adapters.get(id);
  }

  list(): Adapter[] {
    return [...this.adapters.values()];
  }

  /** Resolve adapter from model id (`codex/o3`) or explicit --adapter. */
  resolve(model: string, preferredAdapter?: string): Adapter {
    if (preferredAdapter) {
      const a = this.adapters.get(preferredAdapter);
      if (!a) throw Object.assign(new Error(`Unknown adapter: ${preferredAdapter}`), { status: 400 });
      return a;
    }
    const slash = model.indexOf("/");
    if (slash > 0) {
      const prefix = model.slice(0, slash);
      const a = this.adapters.get(prefix);
      if (a) return a;
    }
    const fallback = this.adapters.get(this.defaultAdapterId);
    if (!fallback) throw Object.assign(new Error("No default adapter registered"), { status: 500 });
    return fallback;
  }
}

export function createRegistry(opts?: CreateRegistryOptions): AdapterRegistry {
  return new AdapterRegistry(opts);
}
