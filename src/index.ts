#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import { Command } from "commander";
import { createRegistry } from "./adapters/registry.js";
import { collectChatText } from "./adapters/types.js";
import { listen } from "./server/listen.js";
import { normalizeChatRequest } from "./protocol/openai.js";
import type { AdapterId } from "./adapters/registry.js";
import { configPathFromArgv, loadConfig, withoutConfigArg, type LoadedConfig } from "./config.js";
import { transformToolEvents } from "./protocol/tools.js";

const DEFAULT_PORT = 3927;

let loadedConfig: LoadedConfig;
try {
  loadedConfig = await loadConfig({ explicitPath: configPathFromArgv(process.argv.slice(2)) });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

function envFlag(name: string): boolean | undefined {
  const value = env(name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be one of: 1, true, yes, on, 0, false, no, off`);
}

function pathList(value: string | undefined): string[] {
  return value?.split(delimiter).map((item) => item.trim()).filter(Boolean) ?? [];
}

function isAdapterId(value: string | undefined): value is AdapterId {
  return value === "mock" || value === "codex" || value === "opencode" || value === "cursor" || value === "claude";
}

interface RegistryCliOptions {
  adapter?: string;
  codexBin?: string;
  opencodeBin?: string;
  cursorBin?: string;
  cursorIsolated?: boolean;
  cursorHidePaths?: string;
  claudeBin?: string;
  cwd?: string;
}

function buildRegistry(opts: RegistryCliOptions) {
  const defaultAdapter = (opts.adapter as AdapterId | undefined) ?? (env("CLI2API_ADAPTER") as AdapterId | undefined) ?? loadedConfig.defaultAdapter ?? "mock";
  return createRegistry({
    defaultAdapter: isAdapterId(defaultAdapter) ? defaultAdapter : "mock",
    modelAliases: loadedConfig.modelAliases,
    modelRoutes: loadedConfig.openRouter?.modelRoutes,
    codex: {
      binary: opts.codexBin ?? env("CLI2API_CODEX_BIN") ?? loadedConfig.binaries?.codex ?? "codex",
      cwd: opts.cwd ?? env("CLI2API_CWD") ?? loadedConfig.cwd,
    },
    opencode: {
      binary: opts.opencodeBin ?? env("CLI2API_OPENCODE_BIN") ?? loadedConfig.binaries?.opencode ?? "opencode",
      cwd: opts.cwd ?? env("CLI2API_CWD") ?? loadedConfig.cwd,
    },
    cursor: {
      binary: opts.cursorBin ?? env("CLI2API_CURSOR_BIN") ?? loadedConfig.binaries?.cursor ?? "cursor-agent",
      cwd: opts.cwd ?? env("CLI2API_CWD") ?? loadedConfig.cwd,
      isolatedWorkspace: opts.cursorIsolated ?? envFlag("CLI2API_CURSOR_ISOLATED") ?? false,
      hiddenPaths: pathList(opts.cursorHidePaths ?? env("CLI2API_CURSOR_HIDE_PATHS")),
    },
    claude: {
      binary: opts.claudeBin ?? env("CLI2API_CLAUDE_BIN") ?? loadedConfig.binaries?.claude ?? "claude",
      cwd: opts.cwd ?? env("CLI2API_CWD") ?? loadedConfig.cwd,
    },
  });
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

const program = new Command();

program
  .name("cli2api")
  .description("Local OpenAI-compatible gateway for coding CLIs (localhost only)")
  .version("0.1.0")
  .option("--config <path>", "JSON config path (also CLI2API_CONFIG)");

program
  .command("serve")
  .description("Start the local OpenAI-compatible HTTP server")
  .option("-p, --port <port>", "Port to listen on", String(Number(env("CLI2API_PORT")) || loadedConfig.port || DEFAULT_PORT))
  .option("-H, --host <host>", "Host to bind (loopback only)", "127.0.0.1")
  .option("-a, --adapter <id>", "Default adapter (mock|codex|opencode|cursor|claude)", env("CLI2API_ADAPTER") ?? loadedConfig.defaultAdapter ?? "mock")
  .option("-t, --token <token>", "Bearer token (also CLI2API_TOKEN); auto-generated if omitted", env("CLI2API_TOKEN") ?? loadedConfig.token)
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--cursor-isolated", "Run each Cursor request in a fresh empty workspace", envFlag("CLI2API_CURSOR_ISOLATED") ?? false)
  .option("--cursor-hide-paths <paths>", `Hide ${delimiter}-separated directories from Cursor (Linux; requires --cursor-isolated)`, env("CLI2API_CURSOR_HIDE_PATHS"))
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--cwd <dir>", "Working directory for CLI adapters", env("CLI2API_CWD") ?? loadedConfig.cwd)
  .option("--openrouter-catalog <mode>", "OpenRouter model catalog: runnable|mirror", env("CLI2API_OPENROUTER_CATALOG") ?? loadedConfig.openRouter?.catalogMode ?? "runnable")
  .option("-v, --verbose", "Log requests", false)
  .action(async (opts) => {
    if (opts.openrouterCatalog !== "runnable" && opts.openrouterCatalog !== "mirror") {
      console.error(`Invalid --openrouter-catalog value: ${opts.openrouterCatalog}. Expected runnable or mirror.`);
      process.exit(1);
    }
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      cursorIsolated: opts.cursorIsolated,
      cursorHidePaths: opts.cursorHidePaths,
      claudeBin: opts.claudeBin,
      cwd: opts.cwd,
    });
    const port = Number(opts.port) || DEFAULT_PORT;
    const tokenProvided = Boolean(opts.token);
    const token: string = opts.token || randomUUID();

    try {
      const server = await listen({
        registry,
        host: opts.host,
        port,
        adapter: opts.adapter,
        token,
        verbose: opts.verbose,
        openRouter: {
          defaultModel: loadedConfig.openRouter?.defaultModel,
          mode: opts.openrouterCatalog === "mirror" ? "mirror" : "runnable",
          annotateAvailability: loadedConfig.openRouter?.annotateAvailability ?? true,
          metadataUrl: loadedConfig.openRouter?.metadataUrl,
          metadataTtlSeconds: loadedConfig.openRouter?.metadataTtlSeconds,
          metadataCachePath: loadedConfig.openRouter?.metadataCachePath,
          pricingEnabled: loadedConfig.openRouter?.pricingEnabled,
          pricingModelMappings: loadedConfig.openRouter?.pricingModelMappings,
          apiKey: env("OPENROUTER_API_KEY"),
        },
      });

      const base = `http://${server.host}:${server.port}`;
      console.error(`cli2api listening on ${base}`);
      console.error(`  adapters: ${registry.list().map((a) => a.id).join(", ")} (default: ${registry.defaultAdapterId})`);
      if (loadedConfig.loadedPaths.length) console.error(`  config:   ${loadedConfig.loadedPaths.join(", ")}`);
      console.error(`  health:   ${base}/health`);
      console.error(`  models:   ${base}/v1/models`);
      console.error(`  chat:     ${base}/v1/chat/completions`);
      console.error(`  openrouter: ${base}/api/v1  (catalog: ${opts.openrouterCatalog})`);
      if (!tokenProvided) {
        console.error(`  token:    ${token}  (generated for this session — set CLI2API_TOKEN to pin it)`);
      }
      console.error("");
      console.error("Env swap:");
      console.error(`  OPENAI_BASE_URL=${base}/v1`);
      console.error(`  OPENAI_API_KEY=${token}`);
      console.error(`  OPENAI_MODEL=${opts.adapter === "mock" ? "mock/echo" : `${opts.adapter}/default`}`);

      const shutdown = () => {
        console.error("\nshutting down…");
        server.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Check installed adapters / CLIs")
  .option("-a, --adapter <id>", "Only check one adapter")
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--json", "Machine-readable JSON", false)
  .action(async (opts) => {
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
    });
    const adapters = opts.adapter
      ? [registry.get(opts.adapter)].filter(Boolean)
      : registry.list();

    if (!adapters.length) {
      console.error(`Unknown adapter: ${opts.adapter}`);
      process.exit(1);
    }

    const reports = await Promise.all(adapters.map((a) => a!.doctor()));
    if (opts.json) {
      printJson({ ok: reports.every((r) => r.ok), adapters: reports });
    } else {
      for (const r of reports) {
        console.log(`${r.ok ? "ok" : "FAIL"}  ${r.adapter}${r.version ? `  (${r.version})` : ""}`);
        for (const c of r.checks) {
          console.log(`  [${c.ok ? "ok" : "x"}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
        }
      }
    }
    process.exit(reports.every((r) => r.ok) ? 0 : 1);
  });

program
  .command("models")
  .description("List models exposed by adapters")
  .option("--json", "Machine-readable JSON", false)
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .action(async (opts) => {
    const registry = buildRegistry({
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
    });
    const models = await registry.listModels();
    if (opts.json) printJson({ object: "list", data: models });
    else for (const m of models) console.log(m.id + (m.description ? `  # ${m.description}` : ""));
  });

program
  .command("completion")
  .description("One-shot smoke completion (no server)")
  .requiredOption("-p, --prompt <text>", "User prompt")
  .option("-m, --model <id>", "Model id", "mock/echo")
  .option("-a, --adapter <id>", "Force adapter")
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--cursor-isolated", "Run the Cursor request in a fresh empty workspace", envFlag("CLI2API_CURSOR_ISOLATED") ?? false)
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--cwd <dir>", "Working directory for CLI adapters", env("CLI2API_CWD"))
  .option("--json", "Print full result as JSON", false)
  .action(async (opts) => {
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      cursorIsolated: opts.cursorIsolated,
      claudeBin: opts.claudeBin,
      cwd: opts.cwd,
    });
    const body = {
      model: opts.model,
      messages: [{ role: "user" as const, content: opts.prompt }],
    };
    const originalReq = normalizeChatRequest(body);
    const req = registry.normalizeRequest(originalReq);
    const adapter = registry.resolve(req.model, opts.adapter);
    const result = await collectChatText(transformToolEvents(adapter.chat(req, new AbortController().signal), req));
    if (opts.json) {
      printJson({ adapter: adapter.id, model: originalReq.model, resolvedModel: req.model, ...result });
    } else if (result.error) {
      console.error(result.error);
      process.exit(1);
    } else {
      process.stdout.write(result.text + (result.text.endsWith("\n") ? "" : "\n"));
    }
    if (result.error) process.exit(1);
  });

program
  .command("adapters")
  .description("List registered adapters")
  .option("--json", "Machine-readable JSON", false)
  .action((opts) => {
    const registry = buildRegistry({});
    const list = registry.list().map((a) => ({ id: a.id, description: a.description }));
    if (opts.json) printJson(list);
    else for (const a of list) console.log(`${a.id}\t${a.description}`);
  });

await program.parseAsync(withoutConfigArg(process.argv));
