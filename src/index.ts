#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createRegistry } from "./adapters/registry.js";
import { collectChatText, limitChatEvents } from "./adapters/types.js";
import { listen, loopbackOrigin } from "./server/listen.js";
import { normalizeChatRequest } from "./protocol/openai.js";
import type { AdapterId } from "./adapters/registry.js";
import { configPathFromArgv, loadConfig, withoutConfigArg, type LoadedConfig } from "./config.js";
import { transformToolEvents } from "./protocol/tools.js";
import { killProcessTree, loopbackNoProxy, prepareSpawnCommand, which } from "./util/process.js";
import type { HealthStatus } from "./types.js";
import { VERSION } from "./version.js";

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

function isAdapterId(value: string | undefined): value is AdapterId {
  return value === "mock"
    || value === "codex"
    || value === "opencode"
    || value === "cursor"
    || value === "claude"
    || value === "gemini"
    || value === "qwen"
    || value === "copilot";
}

interface RegistryCliOptions {
  adapter?: string;
  codexBin?: string;
  opencodeBin?: string;
  cursorBin?: string;
  claudeBin?: string;
  geminiBin?: string;
  qwenBin?: string;
  copilotBin?: string;
  cwd?: string;
}

let isolatedWorkspace: string | undefined;
function adapterCwd(opts: RegistryCliOptions): string {
  const configured = opts.cwd ?? env("CLI2API_CWD") ?? loadedConfig.cwd;
  if (configured) return configured;
  if (!isolatedWorkspace) {
    isolatedWorkspace = mkdtempSync(join(tmpdir(), "cli2api-workspace-"));
    process.once("exit", () => {
      if (isolatedWorkspace) rmSync(isolatedWorkspace, { recursive: true, force: true });
    });
  }
  return isolatedWorkspace;
}

function buildRegistry(opts: RegistryCliOptions) {
  const defaultAdapter = (opts.adapter as AdapterId | undefined) ?? (env("CLI2API_ADAPTER") as AdapterId | undefined) ?? loadedConfig.defaultAdapter ?? "mock";
  const cwd = adapterCwd(opts);
  return createRegistry({
    defaultAdapter: isAdapterId(defaultAdapter) ? defaultAdapter : "mock",
    modelAliases: loadedConfig.modelAliases,
    modelRoutes: loadedConfig.openRouter?.modelRoutes,
    codex: {
      binary: opts.codexBin ?? env("CLI2API_CODEX_BIN") ?? loadedConfig.binaries?.codex ?? "codex",
      cwd,
    },
    opencode: {
      binary: opts.opencodeBin ?? env("CLI2API_OPENCODE_BIN") ?? loadedConfig.binaries?.opencode ?? "opencode",
      cwd,
    },
    cursor: {
      binary: opts.cursorBin ?? env("CLI2API_CURSOR_BIN") ?? loadedConfig.binaries?.cursor ?? "cursor-agent",
      cwd,
    },
    claude: {
      binary: opts.claudeBin ?? env("CLI2API_CLAUDE_BIN") ?? loadedConfig.binaries?.claude ?? "claude",
      cwd,
    },
    gemini: {
      binary: opts.geminiBin ?? env("CLI2API_GEMINI_BIN") ?? loadedConfig.binaries?.gemini ?? "gemini",
      cwd,
    },
    qwen: {
      binary: opts.qwenBin ?? env("CLI2API_QWEN_BIN") ?? loadedConfig.binaries?.qwen ?? "qwen",
      cwd,
    },
    copilot: {
      binary: opts.copilotBin ?? env("CLI2API_COPILOT_BIN") ?? loadedConfig.binaries?.copilot ?? "copilot",
      cwd,
    },
  });
}

function binaryForAdapter(id: Exclude<AdapterId, "mock">, opts: RegistryCliOptions): string {
  const values: Record<Exclude<AdapterId, "mock">, string> = {
    codex: opts.codexBin ?? env("CLI2API_CODEX_BIN") ?? loadedConfig.binaries?.codex ?? "codex",
    opencode: opts.opencodeBin ?? env("CLI2API_OPENCODE_BIN") ?? loadedConfig.binaries?.opencode ?? "opencode",
    cursor: opts.cursorBin ?? env("CLI2API_CURSOR_BIN") ?? loadedConfig.binaries?.cursor ?? "cursor-agent",
    claude: opts.claudeBin ?? env("CLI2API_CLAUDE_BIN") ?? loadedConfig.binaries?.claude ?? "claude",
    gemini: opts.geminiBin ?? env("CLI2API_GEMINI_BIN") ?? loadedConfig.binaries?.gemini ?? "gemini",
    qwen: opts.qwenBin ?? env("CLI2API_QWEN_BIN") ?? loadedConfig.binaries?.qwen ?? "qwen",
    copilot: opts.copilotBin ?? env("CLI2API_COPILOT_BIN") ?? loadedConfig.binaries?.copilot ?? "copilot",
  };
  return values[id];
}

interface AdapterResolution {
  id: AdapterId;
  capability?: HealthStatus;
}

async function resolveAdapter(value: string | undefined, opts: RegistryCliOptions): Promise<AdapterResolution> {
  if (value && value !== "auto") {
    if (!isAdapterId(value)) throw new Error(`Unknown adapter: ${value}`);
    return { id: value };
  }
  const priority: Array<Exclude<AdapterId, "mock">> = [
    // Prefer adapters whose doctor can prove authentication non-interactively;
    // several CLIs expose no safe auth-status command and are tried afterward.
    "codex", "claude", "cursor", "opencode", "gemini", "copilot", "qwen",
  ];
  const paths = await Promise.all(priority.map((id) => which(binaryForAdapter(id, opts))));
  const probeRegistry = buildRegistry({ ...opts, adapter: "mock" });
  for (let index = 0; index < priority.length; index += 1) {
    const id = priority[index]!;
    if (!paths[index]) continue;
    const candidate = probeRegistry.get(id);
    try {
      if (!candidate) continue;
      const capability = await probeRegistry.capabilityReport(candidate);
      if (capability.ok) return { id, capability };
    } catch {
      // A broken optional executable must not prevent probing the next CLI.
    }
  }
  const mock = probeRegistry.get("mock")!;
  return { id: "mock", capability: await probeRegistry.capabilityReport(mock) };
}

function positiveInteger(value: unknown, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function runChild(command: string, args: string[], childEnv: NodeJS.ProcessEnv): Promise<number> {
  const resolvedCommand = await which(command);
  if (!resolvedCommand) throw new Error(`child command not found or not executable: ${command}`);
  const prepared = prepareSpawnCommand(resolvedCommand, args);
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      stdio: "inherit",
      env: childEnv,
      detached: process.platform !== "win32",
    });
    let escalation: NodeJS.Timeout | undefined;
    let forwardedSignal: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (escalation) {
        killProcessTree(child, "SIGKILL");
        return;
      }
      forwardedSignal = signal;
      killProcessTree(child, signal);
      escalation = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
      escalation.unref();
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const cleanup = (forceRemainingTree = false) => {
      if (escalation) {
        clearTimeout(escalation);
        if (forceRemainingTree) killProcessTree(child, "SIGKILL");
      }
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      // Once termination was requested, clean any descendant that outlived
      // the wrapper's direct child before the temporary gateway exits.
      cleanup(Boolean(escalation));
      resolve(forwardedSignal
        ? 128 + (osConstants.signals[forwardedSignal] ?? 0)
        : code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1));
    });
  });
}

const program = new Command();

program
  .name("cli2api")
  .description("Local OpenAI-compatible gateway for coding CLIs (localhost only)")
  .version(VERSION)
  .option("--config <path>", "JSON config path (also CLI2API_CONFIG)");

program
  .command("serve")
  .description("Start the local OpenAI-compatible HTTP server")
  .option("-p, --port <port>", "Port to listen on", String(Number(env("CLI2API_PORT")) || loadedConfig.port || DEFAULT_PORT))
  .option("-H, --host <host>", "Host to bind (loopback only)", "127.0.0.1")
  .option("-a, --adapter <id>", "Default adapter (auto|mock|codex|opencode|cursor|claude|gemini|qwen|copilot)", env("CLI2API_ADAPTER") ?? loadedConfig.defaultAdapter ?? "auto")
  .option("-t, --token <token>", "Bearer token (also CLI2API_TOKEN); auto-generated if omitted", env("CLI2API_TOKEN") ?? loadedConfig.token)
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--gemini-bin <path>", "Gemini CLI binary path", env("CLI2API_GEMINI_BIN"))
  .option("--qwen-bin <path>", "Qwen Code binary path", env("CLI2API_QWEN_BIN"))
  .option("--copilot-bin <path>", "GitHub Copilot CLI binary path", env("CLI2API_COPILOT_BIN"))
  .option("--cwd <dir>", "Working directory for CLI adapters", env("CLI2API_CWD") ?? loadedConfig.cwd)
  .option("--project", "Expose the current project to CLI adapters (same as --cwd .)", false)
  .option("--max-concurrency <n>", "Live subprocesses per adapter", env("CLI2API_MAX_CONCURRENCY") ?? String(loadedConfig.maxConcurrency ?? 2))
  .option("--max-queue <n>", "Waiting requests per adapter", env("CLI2API_MAX_QUEUE") ?? String(loadedConfig.maxQueue ?? 16))
  .option("--max-body-bytes <n>", "Maximum HTTP request body", env("CLI2API_MAX_BODY_BYTES") ?? String(loadedConfig.maxBodyBytes ?? 2 * 1_048_576))
  .option("--openrouter-catalog <mode>", "OpenRouter model catalog: runnable|mirror", env("CLI2API_OPENROUTER_CATALOG") ?? loadedConfig.openRouter?.catalogMode ?? "runnable")
  .option("--json", "Print one machine-readable readiness object to stdout", false)
  .option("-v, --verbose", "Log requests", false)
  .action(async (opts) => {
    if (opts.openrouterCatalog !== "runnable" && opts.openrouterCatalog !== "mirror") {
      console.error(`Invalid --openrouter-catalog value: ${opts.openrouterCatalog}. Expected runnable or mirror.`);
      process.exit(1);
    }
    const registryOptions: RegistryCliOptions = {
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
      geminiBin: opts.geminiBin,
      qwenBin: opts.qwenBin,
      copilotBin: opts.copilotBin,
      cwd: opts.project ? process.cwd() : opts.cwd,
    };
    let selection: AdapterResolution;
    try {
      selection = await resolveAdapter(opts.adapter, registryOptions);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    const selectedAdapter = selection.id;
    const registry = buildRegistry({ ...registryOptions, adapter: selectedAdapter });
    if (selection.capability) registry.primeCapabilityReport(selection.capability);
    let port: number;
    try {
      port = positiveInteger(opts.port, "--port", 0, 65_535);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    const tokenProvided = Boolean(opts.token);
    const token: string = opts.token || randomUUID();

    try {
      const server = await listen({
        registry,
        host: opts.host,
        port,
        adapter: selectedAdapter,
        token,
        verbose: opts.verbose,
        maxConcurrency: positiveInteger(opts.maxConcurrency, "--max-concurrency", 1, 64),
        maxQueue: positiveInteger(opts.maxQueue, "--max-queue", 0, 10_000),
        maxBodyBytes: positiveInteger(opts.maxBodyBytes, "--max-body-bytes", 1_024, 100 * 1_048_576),
        openRouter: {
          defaultModel: loadedConfig.openRouter?.defaultModel,
          mode: opts.openrouterCatalog === "mirror" ? "mirror" : "runnable",
          annotateAvailability: loadedConfig.openRouter?.annotateAvailability ?? true,
          metadataUrl: loadedConfig.openRouter?.metadataUrl,
          metadataTtlSeconds: loadedConfig.openRouter?.metadataTtlSeconds,
          metadataCachePath: loadedConfig.openRouter?.metadataCachePath,
          apiKey: env("OPENROUTER_API_KEY"),
        },
      });

      const base = loopbackOrigin(server.host, server.port);
      const adapterHealth = await registry.capabilityReport(registry.get(selectedAdapter)!);
      const workspace = adapterCwd(registryOptions);
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          ready: true,
          pid: process.pid,
          base_url: base,
          openai_base_url: `${base}/v1`,
          openrouter_base_url: `${base}/api/v1`,
          anthropic_base_url: base,
          token,
          adapter: selectedAdapter,
          adapter_ready: adapterHealth.ok,
          adapter_health: adapterHealth.message,
          model: selectedAdapter === "mock" ? "mock/echo" : `${selectedAdapter}/default`,
          workspace,
          isolated_workspace: workspace === isolatedWorkspace,
        }) + "\n");
      } else {
      console.error(`cli2api listening on ${base}`);
      console.error(`  adapters: ${registry.list().map((a) => a.id).join(", ")} (default: ${registry.defaultAdapterId})`);
      console.error(`  workspace: ${workspace}${workspace === isolatedWorkspace ? " (isolated; use --project or --cwd to expose files)" : ""}`);
      if (!adapterHealth.ok) console.error(`  warning: selected adapter is not ready — ${adapterHealth.message ?? "doctor check failed"}`);
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
      console.error(`  OPENAI_MODEL=${selectedAdapter === "mock" ? "mock/echo" : `${selectedAdapter}/default`}`);
      }

      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error("\nshutting down…");
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", () => { void shutdown(); });
      process.on("SIGTERM", () => { void shutdown(); });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Run a command with a temporary authenticated gateway (no token copying)")
  .argument("<command...>", "Command and arguments; place them after --")
  .option("-a, --adapter <id>", "Adapter (auto by default)", env("CLI2API_ADAPTER") ?? loadedConfig.defaultAdapter ?? "auto")
  .option("-m, --model <id>", "Model exposed to the child command")
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--gemini-bin <path>", "Gemini CLI binary path", env("CLI2API_GEMINI_BIN"))
  .option("--qwen-bin <path>", "Qwen Code binary path", env("CLI2API_QWEN_BIN"))
  .option("--copilot-bin <path>", "GitHub Copilot CLI binary path", env("CLI2API_COPILOT_BIN"))
  .option("--cwd <dir>", "Working directory visible to the CLI adapter", env("CLI2API_CWD") ?? loadedConfig.cwd)
  .option("--project", "Expose the current project to the CLI adapter", false)
  .option("--max-concurrency <n>", "Live subprocesses per adapter", env("CLI2API_MAX_CONCURRENCY") ?? String(loadedConfig.maxConcurrency ?? 2))
  .option("--max-queue <n>", "Waiting requests per adapter", env("CLI2API_MAX_QUEUE") ?? String(loadedConfig.maxQueue ?? 16))
  .option("--max-body-bytes <n>", "Maximum HTTP request body", env("CLI2API_MAX_BODY_BYTES") ?? String(loadedConfig.maxBodyBytes ?? 2 * 1_048_576))
  .option("-v, --verbose", "Log gateway requests", false)
  .action(async (childCommand: string[], opts) => {
    const registryOptions: RegistryCliOptions = {
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
      geminiBin: opts.geminiBin,
      qwenBin: opts.qwenBin,
      copilotBin: opts.copilotBin,
      cwd: opts.project ? process.cwd() : opts.cwd,
    };
    let selection: AdapterResolution;
    try {
      selection = await resolveAdapter(opts.adapter, registryOptions);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }
    const adapter = selection.id;
    const model: string = opts.model ?? (adapter === "mock" ? "mock/echo" : `${adapter}/default`);
    const token = randomUUID();
    const registry = buildRegistry({ ...registryOptions, adapter });
    if (selection.capability) registry.primeCapabilityReport(selection.capability);
    let server: Awaited<ReturnType<typeof listen>> | undefined;
    try {
      server = await listen({
        registry,
        host: "127.0.0.1",
        port: 0,
        adapter,
        token,
        verbose: opts.verbose,
        maxConcurrency: positiveInteger(opts.maxConcurrency, "--max-concurrency", 1, 64),
        maxQueue: positiveInteger(opts.maxQueue, "--max-queue", 0, 10_000),
        maxBodyBytes: positiveInteger(opts.maxBodyBytes, "--max-body-bytes", 1_024, 100 * 1_048_576),
        openRouter: {
          defaultModel: loadedConfig.openRouter?.defaultModel,
          mode: "runnable",
          annotateAvailability: loadedConfig.openRouter?.annotateAvailability ?? true,
          metadataUrl: loadedConfig.openRouter?.metadataUrl,
          metadataTtlSeconds: loadedConfig.openRouter?.metadataTtlSeconds,
          metadataCachePath: loadedConfig.openRouter?.metadataCachePath,
          apiKey: env("OPENROUTER_API_KEY"),
        },
      });
      const base = loopbackOrigin(server.host, server.port);
      const noProxy = loopbackNoProxy(process.env);
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_BASE: `${base}/v1`,
        OPENAI_API_KEY: token,
        OPENAI_MODEL: model,
        OPENROUTER_BASE_URL: `${base}/api/v1`,
        OPENROUTER_API_KEY: token,
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_API_KEY: token,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: model,
        CLI2API_BASE_URL: `${base}/api/v1`,
        CLI2API_TOKEN: token,
        CLI2API_MODEL: model,
      };
      if (opts.verbose) console.error(`[cli2api] temporary ${adapter} gateway at ${base}; model=${model}`);
      process.exitCode = await runChild(childCommand[0]!, childCommand.slice(1), childEnv);
    } catch (error) {
      console.error(`cli2api run: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      if (server) await server.close();
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
  .option("--gemini-bin <path>", "Gemini CLI binary path", env("CLI2API_GEMINI_BIN"))
  .option("--qwen-bin <path>", "Qwen Code binary path", env("CLI2API_QWEN_BIN"))
  .option("--copilot-bin <path>", "GitHub Copilot CLI binary path", env("CLI2API_COPILOT_BIN"))
  .option("--all", "Fail unless every optional CLI is available", false)
  .option("--json", "Machine-readable JSON", false)
  .action(async (opts) => {
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
      geminiBin: opts.geminiBin,
      qwenBin: opts.qwenBin,
      copilotBin: opts.copilotBin,
    });
    const adapters = opts.adapter
      ? [registry.get(opts.adapter)].filter(Boolean)
      : registry.list();

    if (!adapters.length) {
      console.error(`Unknown adapter: ${opts.adapter}`);
      process.exit(1);
    }

    const reports = await Promise.all(adapters.map((a) => a!.doctor()));
    const strict = Boolean(opts.adapter || opts.all);
    const ok = strict ? reports.every((report) => report.ok) : reports.some((report) => report.ok);
    if (opts.json) {
      printJson({
        ok,
        strict,
        available: reports.filter((report) => report.ok).map((report) => report.adapter),
        missing: reports.filter((report) => !report.ok).map((report) => report.adapter),
        adapters: reports,
      });
    } else {
      for (const r of reports) {
        console.log(`${r.ok ? "ok" : strict ? "FAIL" : "skip"}  ${r.adapter}${r.version ? `  (${r.version})` : ""}`);
        for (const c of r.checks) {
          console.log(`  [${c.ok ? "ok" : "x"}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
        }
      }
    }
    process.exit(ok ? 0 : 1);
  });

program
  .command("models")
  .description("List models exposed by adapters")
  .option("--json", "Machine-readable JSON", false)
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--opencode-bin <path>", "OpenCode binary path", env("CLI2API_OPENCODE_BIN"))
  .option("--cursor-bin <path>", "Cursor Agent binary path", env("CLI2API_CURSOR_BIN"))
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--gemini-bin <path>", "Gemini CLI binary path", env("CLI2API_GEMINI_BIN"))
  .option("--qwen-bin <path>", "Qwen Code binary path", env("CLI2API_QWEN_BIN"))
  .option("--copilot-bin <path>", "GitHub Copilot CLI binary path", env("CLI2API_COPILOT_BIN"))
  .action(async (opts) => {
    const registry = buildRegistry({
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
      geminiBin: opts.geminiBin,
      qwenBin: opts.qwenBin,
      copilotBin: opts.copilotBin,
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
  .option("--claude-bin <path>", "Claude Code binary path", env("CLI2API_CLAUDE_BIN"))
  .option("--gemini-bin <path>", "Gemini CLI binary path", env("CLI2API_GEMINI_BIN"))
  .option("--qwen-bin <path>", "Qwen Code binary path", env("CLI2API_QWEN_BIN"))
  .option("--copilot-bin <path>", "GitHub Copilot CLI binary path", env("CLI2API_COPILOT_BIN"))
  .option("--cwd <dir>", "Working directory for CLI adapters", env("CLI2API_CWD"))
  .option("--json", "Print full result as JSON", false)
  .action(async (opts) => {
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      opencodeBin: opts.opencodeBin,
      cursorBin: opts.cursorBin,
      claudeBin: opts.claudeBin,
      geminiBin: opts.geminiBin,
      qwenBin: opts.qwenBin,
      copilotBin: opts.copilotBin,
      cwd: opts.cwd,
    });
    const body = {
      model: opts.model,
      messages: [{ role: "user" as const, content: opts.prompt }],
    };
    const originalReq = normalizeChatRequest(body);
    const req = registry.normalizeRequest(originalReq);
    const adapter = registry.resolve(req.model, opts.adapter);
    const result = await collectChatText(transformToolEvents(limitChatEvents(adapter.chat(req, new AbortController().signal)), req));
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
