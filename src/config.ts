import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const adapterId = z.enum(["mock", "codex", "opencode", "cursor", "claude", "gemini", "qwen", "copilot"]);
const modelRoute = z.object({
  adapter: adapterId,
  model: z.string().min(1),
}).strict();

const configSchema = z.object({
  defaultAdapter: adapterId.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  token: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  maxQueue: z.number().int().min(0).max(10_000).optional(),
  maxBodyBytes: z.number().int().min(1_024).max(100 * 1_048_576).optional(),
  modelAliases: z.record(z.string().min(1)).optional(),
  openRouter: z.object({
    defaultModel: z.string().min(1).optional(),
    catalogMode: z.enum(["runnable", "mirror"]).optional(),
    annotateAvailability: z.boolean().optional(),
    modelRoutes: z.record(modelRoute).optional(),
    metadataUrl: z.string().url().optional(),
    metadataTtlSeconds: z.number().int().min(60).optional(),
    metadataCachePath: z.string().min(1).optional(),
  }).strict().optional(),
  binaries: z.object({
    codex: z.string().min(1).optional(),
    opencode: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    claude: z.string().min(1).optional(),
    gemini: z.string().min(1).optional(),
    qwen: z.string().min(1).optional(),
    copilot: z.string().min(1).optional(),
  }).optional(),
}).strict();

export type Cli2ApiConfig = z.infer<typeof configSchema>;

export interface LoadedConfig extends Cli2ApiConfig {
  loadedPaths: string[];
}

async function readConfig(path: string, required: boolean): Promise<Cli2ApiConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!required && code === "ENOENT") return null;
    throw new Error(`Unable to read cli2api config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in cli2api config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid cli2api config ${path}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

function mergeConfig(base: Cli2ApiConfig, next: Cli2ApiConfig): Cli2ApiConfig {
  return {
    ...base,
    ...next,
    modelAliases: { ...base.modelAliases, ...next.modelAliases },
    openRouter: base.openRouter || next.openRouter ? {
      ...base.openRouter,
      ...next.openRouter,
      modelRoutes: { ...base.openRouter?.modelRoutes, ...next.openRouter?.modelRoutes },
    } : undefined,
    binaries: { ...base.binaries, ...next.binaries },
  };
}

export async function loadConfig(opts: {
  cwd?: string;
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const explicitRaw = opts.explicitPath || env.CLI2API_CONFIG;
  const explicitPath = explicitRaw
    ? (isAbsolute(explicitRaw) ? explicitRaw : resolve(cwd, explicitRaw))
    : undefined;
  const candidates: Array<{ path: string; required: boolean }> = [
    { path: join(xdg, "cli2api", "config.json"), required: false },
  ];
  if (explicitRaw) {
    candidates.push({
      path: explicitPath!,
      required: true,
    });
  }

  let config: Cli2ApiConfig = {};
  const loadedPaths: string[] = [];
  for (const candidate of candidates) {
    const value = await readConfig(candidate.path, candidate.required);
    if (!value) continue;
    config = mergeConfig(config, value);
    loadedPaths.push(candidate.path);
  }
  return { ...config, loadedPaths };
}

/** Extract `--config path` or `--config=path` before Commander parses a subcommand. */
export function configPathFromArgv(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "--config") return argv[index + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return undefined;
}

/** Remove the early-read config option so it is accepted before or after a subcommand. */
export function withoutConfigArg(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      result.push(...argv.slice(index));
      break;
    }
    if (arg === "--config") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) continue;
    result.push(arg);
  }
  return result;
}
