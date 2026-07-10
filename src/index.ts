#!/usr/bin/env node
import { Command } from "commander";
import { createRegistry } from "./adapters/registry.js";
import { collectChatText } from "./adapters/types.js";
import { listen } from "./server/listen.js";
import { normalizeChatRequest } from "./protocol/openai.js";
import type { AdapterId } from "./adapters/registry.js";

const DEFAULT_PORT = 3927;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

function buildRegistry(opts: { adapter?: string; codexBin?: string; cwd?: string }) {
  const defaultAdapter = (opts.adapter as AdapterId | undefined) ?? (env("CLI2API_ADAPTER") as AdapterId | undefined) ?? "mock";
  return createRegistry({
    defaultAdapter: defaultAdapter === "codex" || defaultAdapter === "mock" ? defaultAdapter : "mock",
    codex: {
      binary: opts.codexBin ?? env("CLI2API_CODEX_BIN") ?? "codex",
      cwd: opts.cwd ?? env("CLI2API_CWD"),
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
  .version("0.1.0");

program
  .command("serve")
  .description("Start the local OpenAI-compatible HTTP server")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .option("-H, --host <host>", "Host to bind (loopback only)", "127.0.0.1")
  .option("-a, --adapter <id>", "Default adapter when model has no prefix (mock|codex)", env("CLI2API_ADAPTER") ?? "mock")
  .option("-t, --token <token>", "Optional bearer token (also CLI2API_TOKEN)", env("CLI2API_TOKEN"))
  .option("--codex-bin <path>", "Codex binary path", env("CLI2API_CODEX_BIN"))
  .option("--cwd <dir>", "Working directory for CLI adapters", env("CLI2API_CWD"))
  .option("-v, --verbose", "Log requests", false)
  .action(async (opts) => {
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      cwd: opts.cwd,
    });
    const port = Number(opts.port) || DEFAULT_PORT;

    try {
      const server = await listen({
        registry,
        host: opts.host,
        port,
        adapter: opts.adapter,
        token: opts.token || undefined,
        verbose: opts.verbose,
      });

      const base = `http://${server.host}:${server.port}`;
      console.error(`cli2api listening on ${base}`);
      console.error(`  adapters: ${registry.list().map((a) => a.id).join(", ")} (default: ${registry.defaultAdapterId})`);
      console.error(`  health:   ${base}/health`);
      console.error(`  models:   ${base}/v1/models`);
      console.error(`  chat:     ${base}/v1/chat/completions`);
      console.error("");
      console.error("Env swap:");
      console.error(`  OPENAI_BASE_URL=${base}/v1`);
      console.error(`  OPENAI_API_KEY=${opts.token || "local-dev"}`);
      if (opts.adapter === "codex") {
        console.error(`  OPENAI_MODEL=codex/default`);
      } else {
        console.error(`  OPENAI_MODEL=mock/echo`);
      }

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
  .option("--json", "Machine-readable JSON", false)
  .action(async (opts) => {
    const registry = buildRegistry({ adapter: opts.adapter, codexBin: opts.codexBin });
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
  .action(async (opts) => {
    const registry = buildRegistry({ codexBin: opts.codexBin });
    const all = await Promise.all(registry.list().map((a) => a.listModels()));
    const models = all.flat();
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
  .option("--cwd <dir>", "Working directory for CLI adapters", env("CLI2API_CWD"))
  .option("--json", "Print full result as JSON", false)
  .action(async (opts) => {
    const registry = buildRegistry({
      adapter: opts.adapter,
      codexBin: opts.codexBin,
      cwd: opts.cwd,
    });
    const body = {
      model: opts.model,
      messages: [{ role: "user" as const, content: opts.prompt }],
    };
    const req = normalizeChatRequest(body);
    const adapter = registry.resolve(req.model, opts.adapter);
    const result = await collectChatText(adapter.chat(req, new AbortController().signal));
    if (opts.json) {
      printJson({ adapter: adapter.id, model: req.model, ...result });
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

await program.parseAsync(process.argv);
