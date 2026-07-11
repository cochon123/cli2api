import type { Adapter } from "./types.js";
import type {
  ChatCompletionResponse,
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { requestToPrompt } from "../protocol/openai.js";
import { runCommand, runCommandLines, which } from "../util/process.js";
import { fakeStreamWords } from "./codex.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODELS = ["default", "deepseek-v4-flash-free"];
const DEFAULT_WORD_DELAY_MS = 0;
const READ_ONLY_PERMISSIONS = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
} as const;
let safeConfigHome: string | undefined;

function isolatedConfigHome(): string {
  if (!safeConfigHome) {
    safeConfigHome = mkdtempSync(join(tmpdir(), "cli2api-opencode-config-"));
    process.once("exit", () => {
      if (safeConfigHome) rmSync(safeConfigHome, { recursive: true, force: true });
    });
  }
  return safeConfigHome;
}

function safeConfig(agent: string): string {
  return JSON.stringify({
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    plugin: [],
    instructions: [],
    permission: READ_ONLY_PERMISSIONS,
    agent: {
      [agent]: {
        description: "cli2api read-only inference adapter",
        mode: "primary",
        prompt: "Answer the supplied request. You are read-only and must not invoke mutating, shell, network, or subagent tools.",
        steps: 4,
        permission: READ_ONLY_PERMISSIONS,
      },
    },
  });
}

function storedCredentialStatus(): { ok: boolean; detail: string } {
  const home = homedir();
  const candidates = [
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : undefined,
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, "Library", "Application Support", "opencode", "auth.json"),
    process.env.APPDATA ? join(process.env.APPDATA, "opencode", "auth.json") : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "opencode", "auth.json") : undefined,
  ].filter((path): path is string => Boolean(path));
  for (const path of candidates) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const count = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
      if (count > 0) return { ok: true, detail: `${count} stored credential${count === 1 ? "" : "s"}` };
    } catch {
      // Try the next platform-specific data location.
    }
  }
  return { ok: false, detail: "no stored OpenCode credentials found" };
}

export interface OpenCodeAdapterOptions {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  /** OpenCode agent. A cli2api-owned read-only agent is the default. */
  agent?: string;
  contentWordDelayMs?: number;
}

export type OpenCodeParsedLine =
  | { kind: "content" | "reasoning"; text: string }
  | { kind: "finish"; finishReason: "stop" | "length" | "error"; usage?: ChatCompletionResponse["usage"] }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function openCodeSessionId(line: string): string | undefined {
  try {
    const event = record(JSON.parse(line));
    return event && typeof event.sessionID === "string" && event.sessionID ? event.sessionID : undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenCodeLine(line: string): OpenCodeParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.startsWith("{") ? { kind: "ignore" } : { kind: "content", text: trimmed };
  }
  const event = record(parsed);
  if (!event) return { kind: "ignore" };
  const type = typeof event.type === "string" ? event.type : "";
  const part = record(event.part);
  const text =
    (part && typeof part.text === "string" && part.text) ||
    (typeof event.text === "string" && event.text) ||
    "";

  if (type === "text" && text) return { kind: "content", text };
  if (type === "reasoning" && text) return { kind: "reasoning", text };

  if (type === "step_finish" || type === "step-finish") {
    const reason = part && typeof part.reason === "string" ? part.reason : "stop";
    const tokens = record(part?.tokens);
    let usage: ChatCompletionResponse["usage"];
    if (tokens) {
      const prompt = typeof tokens.input === "number" ? tokens.input : 0;
      const completion = typeof tokens.output === "number" ? tokens.output : 0;
      const total = typeof tokens.total === "number" ? tokens.total : prompt + completion;
      usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
    }
    return {
      kind: "finish",
      finishReason: reason === "length" ? "length" : reason === "error" ? "error" : "stop",
      usage,
    };
  }

  if (type === "error") {
    const error = record(event.error);
    const message =
      (typeof event.message === "string" && event.message) ||
      (error && typeof error.message === "string" && error.message) ||
      "OpenCode stream error";
    return { kind: "error", message };
  }
  return { kind: "ignore" };
}

function localModel(model: string): string | null {
  if (!model || model === "default") return null;
  return model.includes("/") ? model : `opencode/${model}`;
}

export function createOpenCodeAdapter(opts: OpenCodeAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "opencode";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const agent = opts.agent ?? "cli2api";
  const wordDelay = opts.contentWordDelayMs ?? DEFAULT_WORD_DELAY_MS;

  return {
    id: "opencode",
    description: "OpenCode CLI via `opencode run --format json` (isolated read-only agent)",

    async listModels(): Promise<ModelInfo[]> {
      return DEFAULT_MODELS.map((model) => ({
        id: `opencode/${model}`,
        object: "model" as const,
        created: 0,
        owned_by: "opencode",
        description: model === "default" ? "Uses the OpenCode default model" : undefined,
      }));
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `opencode binary not found on PATH (looked for "${binary}"). Install OpenCode or set CLI2API_OPENCODE_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      const args = ["run", "--pure", "--format", "json", "--thinking", "--agent", agent];
      if (req.nativeSessionId) args.push("--session", req.nativeSessionId);
      const model = localModel(req.modelLocal);
      if (model) args.push("--model", model);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      args.push(requestToPrompt(req));

      let sawContent = false;
      let exitCode: number | null = null;
      let timedOut = false;
      let outputLimitExceeded = false;
      let stderr = "";
      let finishReason: "stop" | "length" | "error" = "stop";
      let usage: ChatCompletionResponse["usage"];
      let emittedSessionId: string | undefined;
      const delay = req.stream ? wordDelay : 0;

      try {
        for await (const event of runCommandLines(path, args, {
          cwd: opts.cwd,
          timeoutMs,
          signal,
          env: {
            XDG_CONFIG_HOME: isolatedConfigHome(),
            OPENCODE_CONFIG_DIR: isolatedConfigHome(),
            OPENCODE_CONFIG_CONTENT: safeConfig(agent),
            OPENCODE_PERMISSION: JSON.stringify(READ_ONLY_PERMISSIONS),
            OPENCODE_AUTO_SHARE: "false",
            OPENCODE_DISABLE_AUTOUPDATE: "true",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
            OPENCODE_DISABLE_CLAUDE_CODE: "true",
            OPENCODE_ENABLE_EXA: "false",
            OPENCODE_EXPERIMENTAL: "false",
          },
        })) {
          if (event.type === "stdout_line") {
            const sessionId = openCodeSessionId(event.line);
            if (sessionId && sessionId !== emittedSessionId) {
              emittedSessionId = sessionId;
              yield { type: "session", id: sessionId };
            }
            const parsed = parseOpenCodeLine(event.line);
            if (parsed.kind === "content" || parsed.kind === "reasoning") {
              if (parsed.kind === "content") sawContent = true;
              for await (const delta of fakeStreamWords(
                parsed.text,
                delay,
                signal,
                parsed.kind,
              )) {
                yield delta;
                if (delta.type === "error") return;
              }
            } else if (parsed.kind === "finish") {
              finishReason = parsed.finishReason;
              usage = parsed.usage ?? usage;
            } else if (parsed.kind === "error") {
              yield { type: "error", message: parsed.message, code: "cli_error" };
              return;
            }
          } else if (event.type === "exit") {
            exitCode = event.code;
            timedOut = event.timedOut;
            outputLimitExceeded = event.outputLimitExceeded;
            stderr = event.stderr;
          }
        }
      } catch (error) {
        yield {
          type: "error",
          message: `Failed to spawn opencode: ${error instanceof Error ? error.message : String(error)}`,
          code: "spawn_error",
        };
        return;
      }

      if (timedOut) {
        yield { type: "error", message: `opencode timed out after ${timeoutMs}ms`, code: "timeout" };
      } else if (outputLimitExceeded) {
        yield { type: "error", message: "opencode exceeded the 8 MiB raw process output safety limit", code: "output_limit" };
      } else if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
      } else if (exitCode !== 0) {
        yield {
          type: "error",
          message: `opencode exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : ""}`,
          code: "cli_error",
        };
      } else if (!sawContent) {
        yield { type: "error", message: "opencode returned empty output", code: "empty_output" };
      } else {
        yield { type: "done", finishReason, usage };
      }
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) return { ok: false, adapter: "opencode", details: { binary }, message: "opencode binary not found on PATH" };
      const version = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: version.code === 0,
        adapter: "opencode",
        details: { binary: path, version: (version.stdout || version.stderr).trim(), agent },
        message: version.code === 0 ? "opencode available" : "opencode --version failed",
      };
    },

    async doctor(): Promise<DoctorReport> {
      const path = await which(binary);
      const checks: DoctorReport["checks"] = [{ name: "binary-on-path", ok: Boolean(path), detail: path ?? `missing: ${binary}` }];
      let version: string | undefined;
      if (path) {
        const [result, rootHelp, runHelp] = await Promise.all([
          runCommand(path, ["--version"], { timeoutMs: 8_000 }),
          runCommand(path, ["--help"], { timeoutMs: 8_000 }),
          runCommand(path, ["run", "--help"], { timeoutMs: 8_000 }),
        ]);
        version = (result.stdout || result.stderr).trim();
        checks.push({ name: "version", ok: result.code === 0, detail: version || `exit ${result.code}` });
        const output = rootHelp.stdout + rootHelp.stderr + runHelp.stdout + runHelp.stderr;
        checks.push({
          name: "structured-pure-mode",
          ok: ["--pure", "--format", "--agent"].every((flag) => output.includes(flag)),
          detail: "JSON events, pinned agent, and external-plugin suppression",
        });
        const auth = storedCredentialStatus();
        checks.push({
          name: "authentication",
          ok: auth.ok,
          detail: auth.detail,
        });
      }
      checks.push({
        name: "restrictive-default",
        ok: agent === "cli2api",
        detail: `agent=${agent}; inline deny-by-default permissions; external plugins disabled`,
      });
      return { adapter: "opencode", ok: checks.every((check) => check.ok), binary: path ?? binary, version, checks };
    },
  };
}
