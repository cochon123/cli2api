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

const DEFAULT_MODELS = ["default", "sonnet", "opus", "haiku"];

export interface ClaudeAdapterOptions {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export type ClaudeParsedLine =
  | { kind: "content" | "reasoning"; text: string; partial: boolean }
  | { kind: "session"; id: string }
  | { kind: "result"; text?: string; usage?: ChatCompletionResponse["usage"] }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function assistantBlocks(value: unknown): Array<{ kind: "content" | "reasoning"; text: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ kind: "content" | "reasoning"; text: string }> = [];
  for (const raw of value) {
    const block = record(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      result.push({ kind: "content", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      result.push({ kind: "reasoning", text: block.thinking });
    }
  }
  return result;
}

export function parseClaudeLine(line: string): ClaudeParsedLine[] {
  const trimmed = line.trim();
  if (!trimmed) return [{ kind: "ignore" }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.startsWith("{") ? [{ kind: "ignore" }] : [{ kind: "content", text: trimmed, partial: false }];
  }
  const message = record(parsed);
  if (!message) return [{ kind: "ignore" }];
  const type = typeof message.type === "string" ? message.type : "";

  if (type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
    return [{ kind: "session", id: message.session_id }];
  }

  if (type === "stream_event") {
    const event = record(message.event);
    const delta = record(event?.delta);
    if (event?.type === "content_block_delta" && delta) {
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [{ kind: "content", text: delta.text, partial: true }];
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        return [{ kind: "reasoning", text: delta.thinking, partial: true }];
      }
    }
    return [{ kind: "ignore" }];
  }

  if (type === "assistant") {
    const nested = record(message.message);
    const blocks = assistantBlocks(nested?.content);
    return blocks.length
      ? blocks.map((block) => ({ ...block, partial: false }))
      : [{ kind: "ignore" }];
  }

  if (type === "result") {
    if (message.is_error === true || message.subtype === "error") {
      return [{ kind: "error", message: typeof message.result === "string" ? message.result : "Claude Code failed" }];
    }
    const rawUsage = record(message.usage);
    let usage: ChatCompletionResponse["usage"];
    if (rawUsage) {
      const prompt = typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0;
      const completion = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;
      usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    }
    return [{
      kind: "result",
      text: typeof message.result === "string" ? message.result : undefined,
      usage,
    }];
  }

  if (type === "error") {
    return [{ kind: "error", message: typeof message.message === "string" ? message.message : "Claude Code stream error" }];
  }
  return [{ kind: "ignore" }];
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    id: "claude",
    description: "Claude Code via headless stream-json (plan mode, tools disabled)",

    async listModels(): Promise<ModelInfo[]> {
      return DEFAULT_MODELS.map((model) => ({
        id: `claude/${model}`,
        object: "model" as const,
        created: 0,
        owned_by: "anthropic",
        description: model === "default" ? "Uses the Claude Code default model" : undefined,
      }));
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `claude binary not found on PATH (looked for "${binary}"). Install Claude Code or set CLI2API_CLAUDE_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      // Official headless flags. Empty --tools disables built-ins; strict MCP plus
      // the deny rule prevents configured MCP tools from bypassing that restriction.
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "plan",
        "--tools",
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
      ];
      if (req.nativeSessionId) args.push("--resume", req.nativeSessionId);
      if (req.modelLocal && req.modelLocal !== "default") args.push("--model", req.modelLocal);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      args.push(requestToPrompt(req));

      let sawContent = false;
      let sawPartialContent = false;
      let sawPartialReasoning = false;
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
          inheritEnv: [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
          ],
        })) {
          if (event.type === "stdout_line") {
            for (const parsed of parseClaudeLine(event.line)) {
              if (parsed.kind === "content") {
                if (parsed.partial) {
                  sawPartialContent = true;
                  sawContent = true;
                  yield { type: "delta", text: parsed.text, channel: "content" };
                } else if (!sawPartialContent) {
                  sawContent = true;
                  yield { type: "delta", text: parsed.text, channel: "content" };
                }
              } else if (parsed.kind === "reasoning") {
                if (parsed.partial) {
                  sawPartialReasoning = true;
                  yield { type: "delta", text: parsed.text, channel: "reasoning" };
                } else if (!sawPartialReasoning) {
                  yield { type: "delta", text: parsed.text, channel: "reasoning" };
                }
              } else if (parsed.kind === "session") {
                yield { type: "session", id: parsed.id };
              } else if (parsed.kind === "result") {
                fallbackResult = parsed.text ?? fallbackResult;
                usage = parsed.usage ?? usage;
              } else if (parsed.kind === "error") {
                yield { type: "error", message: parsed.message, code: "cli_error" };
                return;
              }
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
          message: `Failed to spawn claude: ${error instanceof Error ? error.message : String(error)}`,
          code: "spawn_error",
        };
        return;
      }

      if (!sawContent && fallbackResult) {
        sawContent = true;
        yield { type: "delta", text: fallbackResult, channel: "content" };
      }

      if (timedOut) {
        yield { type: "error", message: `claude timed out after ${timeoutMs}ms`, code: "timeout" };
      } else if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
      } else if (exitCode !== 0) {
        yield {
          type: "error",
          message: `claude exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : ""}`,
          code: "cli_error",
        };
      } else if (!sawContent) {
        yield { type: "error", message: "claude returned empty output", code: "empty_output" };
      } else {
        yield { type: "done", finishReason: "stop", usage };
      }
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) return { ok: false, adapter: "claude", details: { binary }, message: "claude binary not found on PATH" };
      const version = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: version.code === 0,
        adapter: "claude",
        details: { binary: path, version: (version.stdout || version.stderr).trim(), permissionMode: "plan", tools: "disabled" },
        message: version.code === 0 ? "claude available" : "claude --version failed",
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
      checks.push({ name: "restrictive-default", ok: true, detail: "permission-mode=plan; built-in and MCP tools disabled" });
      return { adapter: "claude", ok: Boolean(path) && checks.every((check) => check.ok), binary: path ?? binary, version, checks };
    },
  };
}
