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
import { fileURLToPath } from "node:url";

const SAFE_SYSTEM_SETTINGS = fileURLToPath(new URL("./gemini-safe-settings.json", import.meta.url));
const READONLY_ADMIN_POLICY = fileURLToPath(new URL("./gemini-readonly-policy.toml", import.meta.url));

export interface GeminiAdapterOptions {
  binary?: string;
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

function usageFromStats(value: unknown): ChatCompletionResponse["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stats = value as Record<string, unknown>;
  const prompt = typeof stats.input_tokens === "number" ? stats.input_tokens : 0;
  const completion = typeof stats.output_tokens === "number" ? stats.output_tokens : 0;
  const total = typeof stats.total_tokens === "number" ? stats.total_tokens : prompt + completion;
  return prompt || completion || total
    ? { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
    : undefined;
}

/** Parse one official Gemini CLI `--output-format stream-json` event. */
export function parseGeminiLine(line: string): ChatEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!value || typeof value !== "object") return [];
  const event = value as Record<string, unknown>;

  if (event.type === "init" && typeof event.session_id === "string") {
    return [{ type: "session", id: event.session_id }];
  }
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
    return event.content
      ? [{ type: "delta", text: event.content, channel: "content" }]
      : [];
  }
  if (event.type === "error") {
    const message = typeof event.message === "string" ? event.message : "Gemini CLI error";
    if (event.severity === "warning") {
      return [{ type: "delta", text: `[gemini warning] ${message}\n`, channel: "reasoning" }];
    }
    return [{ type: "error", message, code: "cli_error" }];
  }
  if (event.type === "result") {
    if (event.status === "error") {
      const nested = event.error && typeof event.error === "object"
        ? event.error as Record<string, unknown>
        : undefined;
      return [{
        type: "error",
        message: typeof nested?.message === "string" ? nested.message : "Gemini CLI result error",
        code: "cli_error",
      }];
    }
    return [{ type: "done", finishReason: "stop", usage: usageFromStats(event.stats) }];
  }
  return [];
}

export function createGeminiAdapter(opts: GeminiAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "gemini";
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    id: "gemini",
    description: "Google Gemini CLI via native stream-json (plan mode, extensions disabled)",

    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "gemini/default",
        object: "model",
        created: 0,
        owned_by: "gemini-cli",
        description: "Uses the Gemini CLI default model; any CLI-supported model may be requested",
      }];
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `gemini binary not found on PATH (looked for "${binary}"). Install Gemini CLI or set CLI2API_GEMINI_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      const args = [
        "--output-format", "stream-json",
        "--approval-mode", "plan",
        "--extensions", "none",
        "--admin-policy", READONLY_ADMIN_POLICY,
      ];
      if (req.nativeSessionId) args.push("--resume", req.nativeSessionId);
      if (req.modelLocal && req.modelLocal !== "default") args.push("--model", req.modelLocal);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      args.push("--prompt", requestToPrompt(req));

      yield* streamJsonlCommand({
        label: "gemini",
        binary: path,
        args,
        cwd: opts.cwd,
        timeoutMs,
        signal,
        request: req,
        parseLine: parseGeminiLine,
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: SAFE_SYSTEM_SETTINGS },
        inheritEnv: [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_GENAI_USE_VERTEXAI",
          "GOOGLE_CLOUD_PROJECT",
          "GOOGLE_CLOUD_LOCATION",
          "GEMINI_CLI_HOME",
        ],
      });
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) return { ok: false, adapter: "gemini", details: { binary }, message: "gemini binary not found on PATH" };
      const version = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: version.code === 0,
        adapter: "gemini",
        details: { binary: path, version: (version.stdout || version.stderr).trim(), approvalMode: "plan" },
        message: version.code === 0 ? "gemini available" : "gemini --version failed",
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
        checks.push({ name: "stream-json", ok: /stream-json/.test(output), detail: "native JSONL output" });
        checks.push({ name: "plan-mode", ok: /approval-mode/.test(output), detail: "read-only approval mode" });
        checks.push({ name: "admin-policy", ok: /admin-policy/.test(output), detail: "cli2api read-only policy overrides user policy" });
        checks.push({ name: "customization-control", ok: /extensions/.test(output), detail: "extensions can be disabled" });
      }
      return { adapter: "gemini", ok: checks.every((check) => check.ok), binary: path ?? undefined, version, checks };
    },
  };
}
