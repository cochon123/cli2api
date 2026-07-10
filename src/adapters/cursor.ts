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

const DEFAULT_MODELS = ["default", "composer-2.5", "composer-2.5-fast"];

export interface CursorAdapterOptions {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  /** Cursor read-only mode. */
  mode?: "ask" | "plan";
  /** Headless Cursor requires explicit workspace trust. */
  trust?: boolean;
}

export type CursorParsedLine =
  | { kind: "content" | "reasoning"; text: string; partial: boolean }
  | { kind: "session"; id: string }
  | { kind: "result"; text?: string; usage?: ChatCompletionResponse["usage"] }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const item = record(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

export function parseCursorLine(line: string): CursorParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.startsWith("{") ? { kind: "ignore" } : { kind: "content", text: trimmed, partial: false };
  }
  const event = record(parsed);
  if (!event) return { kind: "ignore" };
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    return { kind: "session", id: event.session_id };
  }

  if (type === "thinking" && event.subtype === "delta" && typeof event.text === "string") {
    return { kind: "reasoning", text: event.text, partial: true };
  }
  if (type === "assistant") {
    const message = record(event.message);
    const text = contentText(message?.content);
    if (text) return { kind: "content", text, partial: typeof event.timestamp_ms === "number" };
  }
  if (type === "result") {
    if (event.is_error === true || event.subtype === "error") {
      return { kind: "error", message: typeof event.result === "string" ? event.result : "Cursor agent failed" };
    }
    const rawUsage = record(event.usage);
    let usage: ChatCompletionResponse["usage"];
    if (rawUsage) {
      const prompt = typeof rawUsage.inputTokens === "number" ? rawUsage.inputTokens : 0;
      const completion = typeof rawUsage.outputTokens === "number" ? rawUsage.outputTokens : 0;
      usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    }
    return {
      kind: "result",
      text: typeof event.result === "string" ? event.result : undefined,
      usage,
    };
  }
  if (type === "error") {
    return { kind: "error", message: typeof event.message === "string" ? event.message : "Cursor agent stream error" };
  }
  return { kind: "ignore" };
}

export function createCursorAdapter(opts: CursorAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "cursor-agent";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const mode = opts.mode ?? "ask";
  const trust = opts.trust ?? true;

  return {
    id: "cursor",
    description: "Cursor Agent CLI via native partial stream-json (read-only ask mode)",

    async listModels(): Promise<ModelInfo[]> {
      return DEFAULT_MODELS.map((model) => ({
        id: `cursor/${model}`,
        object: "model" as const,
        created: 0,
        owned_by: "cursor",
        description: model === "default" ? "Uses the Cursor Agent default model" : undefined,
      }));
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `cursor-agent binary not found on PATH (looked for "${binary}"). Install Cursor Agent or set CLI2API_CURSOR_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--mode",
        mode,
        "--sandbox",
        "enabled",
      ];
      if (trust) args.push("--trust");
      if (req.nativeSessionId) args.push("--resume", req.nativeSessionId);
      if (req.modelLocal && req.modelLocal !== "default") args.push("--model", req.modelLocal);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      args.push(requestToPrompt(req));

      let sawContent = false;
      let sawPartialContent = false;
      let fallbackResult = "";
      let usage: ChatCompletionResponse["usage"];
      let exitCode: number | null = null;
      let timedOut = false;
      let stderr = "";

      try {
        for await (const event of runCommandLines(path, args, {
          cwd: opts.cwd,
          timeoutMs,
          signal,
          inheritEnv: ["CURSOR_API_KEY"],
        })) {
          if (event.type === "stdout_line") {
            const parsed = parseCursorLine(event.line);
            if (parsed.kind === "session") {
              yield { type: "session", id: parsed.id };
            } else if (parsed.kind === "reasoning") {
              yield { type: "delta", text: parsed.text, channel: "reasoning" };
            } else if (parsed.kind === "content") {
              // Cursor emits partial deltas, then repeats the full answer without a timestamp.
              if (parsed.partial) {
                sawPartialContent = true;
                sawContent = true;
                yield { type: "delta", text: parsed.text, channel: "content" };
              } else if (!sawPartialContent) {
                sawContent = true;
                yield { type: "delta", text: parsed.text, channel: "content" };
              }
            } else if (parsed.kind === "result") {
              fallbackResult = parsed.text ?? fallbackResult;
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
          message: `Failed to spawn cursor-agent: ${error instanceof Error ? error.message : String(error)}`,
          code: "spawn_error",
        };
        return;
      }

      if (!sawContent && fallbackResult) {
        sawContent = true;
        yield { type: "delta", text: fallbackResult, channel: "content" };
      }

      if (timedOut) {
        yield { type: "error", message: `cursor-agent timed out after ${timeoutMs}ms`, code: "timeout" };
      } else if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
      } else if (exitCode !== 0) {
        yield {
          type: "error",
          message: `cursor-agent exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : ""}`,
          code: "cli_error",
        };
      } else if (!sawContent) {
        yield { type: "error", message: "cursor-agent returned empty output", code: "empty_output" };
      } else {
        yield { type: "done", finishReason: "stop", usage };
      }
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) return { ok: false, adapter: "cursor", details: { binary }, message: "cursor-agent binary not found on PATH" };
      const version = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: version.code === 0,
        adapter: "cursor",
        details: {
          binary: path,
          version: (version.stdout || version.stderr).trim() || "not emitted without a TTY",
          mode,
          sandbox: "enabled",
        },
        message: version.code === 0 ? "cursor-agent available" : "cursor-agent --version failed",
      };
    },

    async doctor(): Promise<DoctorReport> {
      const path = await which(binary);
      const checks: DoctorReport["checks"] = [{ name: "binary-on-path", ok: Boolean(path), detail: path ?? `missing: ${binary}` }];
      let version: string | undefined;
      if (path) {
        const result = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
        version = (result.stdout || result.stderr).trim() || undefined;
        checks.push({
          name: "version",
          ok: result.code === 0,
          detail: version ?? (result.code === 0 ? "available; CLI emitted no version without a TTY" : `exit ${result.code}`),
        });
      }
      checks.push({ name: "restrictive-default", ok: mode === "ask" || mode === "plan", detail: `mode=${mode}; sandbox=enabled` });
      return { adapter: "cursor", ok: checks.every((check) => check.ok), binary: path ?? binary, version, checks };
    },
  };
}
