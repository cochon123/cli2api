import type { Adapter } from "./types.js";
import { createMockAdapter } from "./mock.js";
import { createCodexAdapter, type CodexAdapterOptions } from "./codex.js";
import { createOpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode.js";
import { createCursorAdapter, type CursorAdapterOptions } from "./cursor.js";
import { createClaudeAdapter, type ClaudeAdapterOptions } from "./claude.js";
import { createGeminiAdapter, type GeminiAdapterOptions } from "./gemini.js";
import { createQwenAdapter, type QwenAdapterOptions } from "./qwen.js";
import { createCopilotAdapter, type CopilotAdapterOptions } from "./copilot.js";
import { parseModelId } from "../protocol/openai.js";
import type { HealthStatus, ModelRoute, NormalizedChatRequest } from "../types.js";

export type AdapterId =
  | "mock"
  | "codex"
  | "opencode"
  | "cursor"
  | "claude"
  | "gemini"
  | "qwen"
  | "copilot";

export interface CreateRegistryOptions {
  defaultAdapter?: AdapterId;
  codex?: CodexAdapterOptions;
  opencode?: OpenCodeAdapterOptions;
  cursor?: CursorAdapterOptions;
  claude?: ClaudeAdapterOptions;
  gemini?: GeminiAdapterOptions;
  qwen?: QwenAdapterOptions;
  copilot?: CopilotAdapterOptions;
  modelAliases?: Record<string, string>;
  modelRoutes?: Record<string, ModelRoute>;
}

export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();
  readonly defaultAdapterId: string;
  readonly modelAliases: Readonly<Record<string, string>>;
  readonly modelRoutes: Readonly<Record<string, ModelRoute>>;
  private readonly capabilityCache = new Map<string, { expiresAt: number; report: HealthStatus }>();
  private readonly capabilityRefresh = new Map<string, Promise<HealthStatus>>();
  private readonly runtimeHealthCache = new Map<string, { expiresAt: number; report: HealthStatus }>();
  private readonly runtimeHealthRefresh = new Map<string, Promise<HealthStatus>>();

  constructor(opts: CreateRegistryOptions = {}) {
    this.defaultAdapterId = opts.defaultAdapter ?? "mock";
    this.modelAliases = Object.freeze({ ...(opts.modelAliases ?? {}) });
    this.modelRoutes = Object.freeze({ ...(opts.modelRoutes ?? {}) });
    this.register(createMockAdapter());
    this.register(createCodexAdapter(opts.codex));
    this.register(createOpenCodeAdapter(opts.opencode));
    this.register(createCursorAdapter(opts.cursor));
    this.register(createClaudeAdapter(opts.claude));
    this.register(createGeminiAdapter(opts.gemini));
    this.register(createQwenAdapter(opts.qwen));
    this.register(createCopilotAdapter(opts.copilot));
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

  async capabilityReport(adapter: Adapter, ttlMs = 5 * 60_000): Promise<HealthStatus> {
    const cached = this.capabilityCache.get(adapter.id);
    if (cached && cached.expiresAt > Date.now()) return cached.report;
    const pending = this.capabilityRefresh.get(adapter.id);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        // `--version` alone does not prove that the installed release supports
        // the structured and restrictive flags this gateway relies on.
        const report = await adapter.doctor();
        return {
          ok: report.ok,
          adapter: report.adapter,
          message: report.ok ? `${report.adapter} adapter contract ready` : `${report.adapter} adapter contract check failed`,
          details: { binary: report.binary, version: report.version, checks: report.checks },
        } satisfies HealthStatus;
      } catch (error) {
        return {
          ok: false,
          adapter: adapter.id,
          message: `adapter capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
          details: {},
        } satisfies HealthStatus;
      }
    })().then((report) => {
      this.capabilityCache.set(adapter.id, { report, expiresAt: Date.now() + ttlMs });
      return report;
    }).finally(() => this.capabilityRefresh.delete(adapter.id));
    this.capabilityRefresh.set(adapter.id, refresh);
    return refresh;
  }

  primeCapabilityReport(report: HealthStatus, ttlMs = 5 * 60_000): void {
    this.capabilityCache.set(report.adapter, { report, expiresAt: Date.now() + ttlMs });
  }

  async runtimeHealth(adapter: Adapter, ttlMs = 10_000): Promise<HealthStatus> {
    const cached = this.runtimeHealthCache.get(adapter.id);
    if (cached && cached.expiresAt > Date.now()) return cached.report;
    const pending = this.runtimeHealthRefresh.get(adapter.id);
    if (pending) return pending;
    const refresh = adapter.health().catch((error): HealthStatus => ({
      ok: false,
      adapter: adapter.id,
      message: `adapter health probe failed: ${error instanceof Error ? error.message : String(error)}`,
      details: {},
    })).then((report) => {
      this.runtimeHealthCache.set(adapter.id, { report, expiresAt: Date.now() + ttlMs });
      return report;
    }).finally(() => this.runtimeHealthRefresh.delete(adapter.id));
    this.runtimeHealthRefresh.set(adapter.id, refresh);
    return refresh;
  }

  async healthReports(ttlMs = 5 * 60_000): Promise<HealthStatus[]> {
    return Promise.all(this.list().map((adapter) => this.capabilityReport(adapter, ttlMs)));
  }

  async availableAdapterIds(): Promise<Set<string>> {
    return new Set((await this.healthReports()).filter((report) => report.ok).map((report) => report.adapter));
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
    const route = this.modelRoutes[current];
    return route ? `${route.adapter}/${route.model}` : current;
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
    const routes = Object.entries(this.modelRoutes).map(([id, target]) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "cli2api-openrouter-route",
      description: `Routes to ${target.adapter}/${target.model}`,
    }));
    return [...all, ...aliases, ...routes];
  }

  async listRunnableModels(): Promise<import("../types.js").ModelInfo[]> {
    const available = await this.availableAdapterIds();
    return (await this.listModels()).filter((model) => {
      try {
        return available.has(this.resolve(model.id).id);
      } catch {
        return false;
      }
    });
  }

  isExplicitlyRoutable(model: string): boolean {
    const resolved = this.resolveModelId(model);
    const slash = resolved.indexOf("/");
    if (slash < 0) return Boolean(this.modelAliases[model]);
    return this.adapters.has(resolved.slice(0, slash));
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
