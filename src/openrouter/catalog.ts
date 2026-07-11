import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ModelInfo } from "../types.js";

export type OpenRouterCatalogMode = "runnable" | "mirror";

export interface OpenRouterCatalogOptions {
  mode?: OpenRouterCatalogMode;
  annotateAvailability?: boolean;
  metadataUrl?: string;
  metadataTtlSeconds?: number;
  metadataCachePath?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface CacheEnvelope {
  sourceUrl: string;
  fetchedAt: number;
  data: Array<Record<string, unknown>>;
}

const DEFAULT_METADATA_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_SECONDS = 86_400;
const LOCALLY_SUPPORTED_PARAMETERS = ["tools", "tool_choice", "reasoning", "include_reasoning"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function modelId(model: Record<string, unknown>): string | undefined {
  return typeof model.id === "string" ? model.id : undefined;
}

function cachePath(path?: string): string {
  if (path) return resolve(path);
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "cli2api", "openrouter-models.json");
}

function annotate(
  model: Record<string, unknown>,
  registry: AdapterRegistry,
): Record<string, unknown> {
  const id = modelId(model) ?? "";
  const route = registry.modelRoutes[id];
  const available = Boolean(route) || registry.isExplicitlyRoutable(id);
  return {
    ...model,
    cli2api: {
      available,
      ...(route ? { adapter: route.adapter, local_model: route.model } : {}),
    },
  };
}

function filterModels(models: Array<Record<string, unknown>>, query?: URLSearchParams): Array<Record<string, unknown>> {
  if (!query) return models;
  const q = query.get("q")?.trim().toLowerCase();
  const supported = query.get("supported_parameters")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  const input = query.get("input_modalities")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  const output = query.get("output_modalities")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return models.filter((model) => {
    if (q) {
      const haystack = `${String(model.id ?? "")} ${String(model.name ?? "")} ${String(model.description ?? "")}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    if (supported.some((parameter) => !parameters.includes(parameter))) return false;
    const architecture = isRecord(model.architecture) ? model.architecture : {};
    const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
    const outputModalities = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
    if (input.some((modality) => !inputModalities.includes(modality))) return false;
    if (output.some((modality) => !outputModalities.includes(modality))) return false;
    return true;
  });
}

export class OpenRouterCatalog {
  private readonly mode: OpenRouterCatalogMode;
  private readonly annotateAvailability: boolean;
  private readonly metadataUrl: string;
  private readonly ttlMs: number;
  private readonly path: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private memory?: CacheEnvelope;
  private refresh?: Promise<CacheEnvelope | undefined>;

  constructor(private readonly registry: AdapterRegistry, opts: OpenRouterCatalogOptions = {}) {
    this.mode = opts.mode ?? "runnable";
    this.annotateAvailability = opts.annotateAvailability ?? true;
    this.metadataUrl = opts.metadataUrl ?? DEFAULT_METADATA_URL;
    this.ttlMs = (opts.metadataTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.path = cachePath(opts.metadataCachePath);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async readCache(): Promise<CacheEnvelope | undefined> {
    if (this.memory) return this.memory;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isRecord(parsed)
        || parsed.sourceUrl !== this.metadataUrl
        || typeof parsed.fetchedAt !== "number"
        || !Array.isArray(parsed.data)) return undefined;
      const data = parsed.data.filter(isRecord);
      this.memory = { sourceUrl: this.metadataUrl, fetchedAt: parsed.fetchedAt, data };
      return this.memory;
    } catch {
      return undefined;
    }
  }

  private async fetchCatalog(): Promise<CacheEnvelope | undefined> {
    try {
      const headers: Record<string, string> = {};
      const metadataOrigin = new URL(this.metadataUrl).origin;
      const maySendOpenRouterKey = metadataOrigin === "https://openrouter.ai";
      if (this.apiKey && maySendOpenRouterKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(this.metadataUrl, {
        headers,
        redirect: maySendOpenRouterKey ? "error" : "follow",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return undefined;
      const payload = await response.json() as unknown;
      if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
      const envelope = { sourceUrl: this.metadataUrl, fetchedAt: Date.now(), data: payload.data.filter(isRecord) };
      this.memory = envelope;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, JSON.stringify(envelope), "utf8");
      } catch {
        // A read-only cache directory must not break the local API.
      }
      return envelope;
    } catch {
      return undefined;
    }
  }

  private async upstream(): Promise<CacheEnvelope | undefined> {
    const cached = await this.readCache();
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached;
    this.refresh ??= this.fetchCatalog().finally(() => { this.refresh = undefined; });
    const fresh = await this.refresh;
    return fresh ?? cached;
  }

  async list(query?: URLSearchParams): Promise<Array<Record<string, unknown>>> {
    const local = await this.registry.listModels();
    const shouldLoadUpstream = this.mode === "mirror" || Object.keys(this.registry.modelRoutes).length > 0;
    const upstreamSnapshot = shouldLoadUpstream ? await this.upstream() : undefined;
    const upstream = upstreamSnapshot?.data ?? [];

    if (this.mode === "mirror") {
      const models = this.annotateAvailability
        ? upstream.map((model) => annotate(model, this.registry))
        : upstream;
      return filterModels(models, query);
    }

    const upstreamById = new Map(upstream.map((model) => [modelId(model), model]));
    const seen = new Set<string>();
    const models = local.flatMap((fallback: ModelInfo) => {
      if (seen.has(fallback.id)) return [];
      seen.add(fallback.id);
      const actual = upstreamById.get(fallback.id);
      const merged: Record<string, unknown> = actual
        ? { ...actual, supported_parameters: LOCALLY_SUPPORTED_PARAMETERS.filter((parameter) =>
            Array.isArray(actual.supported_parameters) && actual.supported_parameters.includes(parameter)) }
        : { ...fallback, supported_parameters: LOCALLY_SUPPORTED_PARAMETERS };
      return [this.annotateAvailability ? annotate(merged, this.registry) : merged];
    });
    return filterModels(models, query);
  }
}
