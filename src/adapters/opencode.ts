import type { Adapter } from "./types.js";
import type {
  ChatCompletionResponse,
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { messagesToPrompt } from "../protocol/openai.js";
import { runCommand, runCommandLines, which } from "../util/process.js";
import { fakeStreamWords } from "./codex.js";

const DEFAULT_MODELS = ["default", "deepseek-v4-flash-free"];
const DEFAULT_WORD_DELAY_MS = 28;

export interface OpenCodeAdapterOptions {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  /** OpenCode agent. `plan` is the safe, read-only default. */
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
  const agent = opts.agent ?? "plan";
  const wordDelay = opts.contentWordDelayMs ?? DEFAULT_WORD_DELAY_MS;

  return {
    id: "opencode",
    description: "OpenCode CLI via `opencode run --format json` (plan agent)",

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
      const model = localModel(req.modelLocal);
      if (model) args.push("--model", model);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      args.push(messagesToPrompt(req.messages));

      let sawContent = false;
      let exitCode: number | null = null;
      let timedOut = false;
      let stderr = "";
      let finishReason: "stop" | "length" | "error" = "stop";
      let usage: ChatCompletionResponse["usage"];
      const delay = req.stream ? wordDelay : 0;

      try {
        for await (const event of runCommandLines(path, args, {
          cwd: opts.cwd,
          timeoutMs,
          signal,
          inheritEnv: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"],
        })) {
          if (event.type === "stdout_line") {
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
        const result = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
        version = (result.stdout || result.stderr).trim();
        checks.push({ name: "version", ok: result.code === 0, detail: version || `exit ${result.code}` });
      }
      checks.push({ name: "restrictive-default", ok: agent === "plan", detail: `agent=${agent}; external plugins disabled` });
      return { adapter: "opencode", ok: checks.every((check) => check.ok), binary: path ?? binary, version, checks };
    },
  };
}
