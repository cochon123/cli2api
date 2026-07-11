import type { Adapter } from "./types.js";
import type {
  ChatEvent,
  ChatCompletionResponse,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { requestToPrompt } from "../protocol/openai.js";
import { runCommand, which } from "../util/process.js";
import { streamJsonlCommand } from "./jsonl.js";

export interface QwenAdapterOptions {
  binary?: string;
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

function qwenUsage(value: unknown): ChatCompletionResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const prompt = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const completion = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : prompt + completion;
  return prompt || completion || total
    ? { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
    : undefined;
}

function textBlocks(message: unknown, type: "text" | "thinking"): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const block = part as Record<string, unknown>;
    if (block.type !== type) return [];
    const value = type === "text" ? block.text : block.thinking;
    return typeof value === "string" ? [value] : [];
  }).join("");
}

/** Parser factory for Qwen's official stream-json protocol. */
export function createQwenParser(): (line: string) => ChatEvent[] {
  let sawPartialText = false;
  let sawPartialThinking = false;
  let sawAnyContent = false;

  return (line: string): ChatEvent[] => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [];
    }
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;

    if (record.type === "system" && record.subtype === "session_start" && typeof record.session_id === "string") {
      return [{ type: "session", id: record.session_id }];
    }
    if (record.type === "stream_event" && record.event && typeof record.event === "object") {
      const event = record.event as Record<string, unknown>;
      if (event.type === "content_block_delta" && event.delta && typeof event.delta === "object") {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          sawPartialText = true;
          sawAnyContent = true;
          return [{ type: "delta", text: delta.text, channel: "content" }];
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          sawPartialThinking = true;
          return [{ type: "delta", text: delta.thinking, channel: "reasoning" }];
        }
      }
      return [];
    }
    if (record.type === "assistant") {
      const events: ChatEvent[] = [];
      const text = textBlocks(record.message, "text");
      const thinking = textBlocks(record.message, "thinking");
      if (text && !sawPartialText) {
        sawAnyContent = true;
        events.push({ type: "delta", text, channel: "content" });
      }
      if (thinking && !sawPartialThinking) events.push({ type: "delta", text: thinking, channel: "reasoning" });
      return events;
    }
    if (record.type === "result") {
      if (record.is_error === true || record.subtype !== "success") {
        const nested = record.error && typeof record.error === "object"
          ? record.error as Record<string, unknown>
          : undefined;
        return [{
          type: "error",
          message: typeof nested?.message === "string" ? nested.message : `Qwen Code ${String(record.subtype ?? "error")}`,
          code: "cli_error",
        }];
      }
      const events: ChatEvent[] = [];
      if (!sawAnyContent && typeof record.result === "string" && record.result) {
        sawAnyContent = true;
        events.push({ type: "delta", text: record.result, channel: "content" });
      }
      events.push({ type: "done", finishReason: "stop", usage: qwenUsage(record.usage) });
      return events;
    }
    return [];
  };
}

export function createQwenAdapter(opts: QwenAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "qwen";
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    id: "qwen",
    description: "Qwen Code via partial stream-json (safe + plan modes, bounded tools/time)",

    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "qwen/default",
        object: "model",
        created: 0,
        owned_by: "qwen-code",
        description: "Uses the Qwen Code default model; any CLI-supported model may be requested",
      }];
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `qwen binary not found on PATH (looked for "${binary}"). Install Qwen Code or set CLI2API_QWEN_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      const args = [
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--safe-mode",
        "--approval-mode", "plan",
        "--exclude-tools", "shell,write,edit,agent",
        "--max-session-turns", "4",
        "--max-wall-time", `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
        // This adapter receives the complete request context in its prompt; it
        // does not need Qwen's local tools. Zero is an enforced execution cap.
        "--max-tool-calls", "0",
      ];
      if (req.nativeSessionId) args.push("--resume", req.nativeSessionId);
      if (req.modelLocal && req.modelLocal !== "default") args.push("--model", req.modelLocal);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      args.push("--prompt", requestToPrompt(req));

      yield* streamJsonlCommand({
        label: "qwen",
        binary: path,
        args,
        cwd: opts.cwd,
        timeoutMs,
        signal,
        request: req,
        parseLine: createQwenParser(),
        inheritEnv: [
          "QWEN_API_KEY",
          "DASHSCOPE_API_KEY",
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "BAILIAN_CODING_PLAN_API_KEY",
          "QWEN_HOME",
          "QWEN_RUNTIME_DIR",
        ],
      });
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) return { ok: false, adapter: "qwen", details: { binary }, message: "qwen binary not found on PATH" };
      const version = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: version.code === 0,
        adapter: "qwen",
        details: { binary: path, version: (version.stdout || version.stderr).trim(), safeMode: true, approvalMode: "plan" },
        message: version.code === 0 ? "qwen available" : "qwen --version failed",
      };
    },

    async doctor(): Promise<DoctorReport> {
      const checks: DoctorReport["checks"] = [];
      const path = await which(binary);
      checks.push({ name: "binary-on-path", ok: Boolean(path), detail: path ?? `missing: ${binary}` });
      let version: string | undefined;
      if (path) {
        const [result, help] = await Promise.all([
          runCommand(path, ["--version"], { timeoutMs: 8_000 }),
          runCommand(path, ["--help"], { timeoutMs: 8_000 }),
        ]);
        version = (result.stdout || result.stderr).trim();
        checks.push({ name: "version", ok: result.code === 0, detail: version || `exit ${result.code}` });
        const output = help.stdout + help.stderr;
        checks.push({ name: "partial-stream-json", ok: /include-partial-messages/.test(output), detail: "native partial JSONL output" });
        checks.push({ name: "safe-mode", ok: /safe-mode/.test(output), detail: "customizations disabled" });
        checks.push({
          name: "run-budgets",
          ok: ["max-session-turns", "max-wall-time", "max-tool-calls"].every((flag) => output.includes(flag)),
          detail: "bounded turns, wall time, and tool calls",
        });
      }
      return { adapter: "qwen", ok: checks.every((check) => check.ok), binary: path ?? undefined, version, checks };
    },
  };
}
