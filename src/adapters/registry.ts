import type { Adapter } from "./types.js";
import { createMockAdapter } from "./mock.js";
import { createCodexAdapter, type CodexAdapterOptions } from "./codex.js";
import { createOpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode.js";
import { createCursorAdapter, type CursorAdapterOptions } from "./cursor.js";
import { createClaudeAdapter, type ClaudeAdapterOptions } from "./claude.js";
import { parseModelId } from "../protocol/openai.js";
import type { NormalizedChatRequest } from "../types.js";

export type AdapterId = "mock" | "codex" | "opencode" | "cursor" | "claude";

export interface CreateRegistryOptions {
  defaultAdapter?: AdapterId;
  codex?: CodexAdapterOptions;
  opencode?: OpenCodeAdapterOptions;
  cursor?: CursorAdapterOptions;
  claude?: ClaudeAdapterOptions;
  modelAliases?: Record<string, string>;
}

export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();
  readonly defaultAdapterId: string;
  readonly modelAliases: Readonly<Record<string, string>>;

  constructor(opts: CreateRegistryOptions = {}) {
    this.defaultAdapterId = opts.defaultAdapter ?? "mock";
    this.modelAliases = Object.freeze({ ...(opts.modelAliases ?? {}) });
    this.register(createMockAdapter());
    this.register(createCodexAdapter(opts.codex));
    this.register(createOpenCodeAdapter(opts.opencode));
    this.register(createCursorAdapter(opts.cursor));
    this.register(createClaudeAdapter(opts.claude));
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

  resolveModelId(model: string): string {
    let current = model;
    const seen = new Set<string>();
    while (this.modelAliases[current]) {
      if (seen.has(current)) {
        throw Object.assign(new Error(`Model alias cycle detected at: ${current}`), { status: 400 });
      }
      seen.add(current);
      current = this.modelAliases[current];
    }
    return current;
  }

  normalizeRequest(req: NormalizedChatRequest): NormalizedChatRequest {
    const model = this.resolveModelId(req.model);
    const { modelLocal } = parseModelId(model);
    return { ...req, model, modelLocal };
  }

  async listModels(): Promise<import("../types.js").ModelInfo[]> {
    const all = (await Promise.all(this.list().map((adapter) => adapter.listModels()))).flat();
    const aliases = Object.entries(this.modelAliases).map(([id, target]) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "cli2api-alias",
      description: `Alias for ${target}`,
    }));
    return [...all, ...aliases];
  }

  /** Resolve adapter from model id (`codex/o3`) or explicit --adapter. */
  resolve(model: string, preferredAdapter?: string): Adapter {
    model = this.resolveModelId(model);
    const slash = model.indexOf("/");
    if (slash > 0) {
      const prefix = model.slice(0, slash);
      const a = this.adapters.get(prefix);
      if (a) return a;
    }
    if (preferredAdapter) {
      const a = this.adapters.get(preferredAdapter);
      if (!a) throw Object.assign(new Error(`Unknown adapter: ${preferredAdapter}`), { status: 400 });
      return a;
    }
    const fallback = this.adapters.get(this.defaultAdapterId);
    if (!fallback) throw Object.assign(new Error("No default adapter registered"), { status: 500 });
    return fallback;
  }
}

export function createRegistry(opts?: CreateRegistryOptions): AdapterRegistry {
  return new AdapterRegistry(opts);
}
