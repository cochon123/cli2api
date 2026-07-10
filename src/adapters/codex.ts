import type { Adapter } from "./types.js";
import type {
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { requestToPrompt } from "../protocol/openai.js";
import { runCommand, runCommandLines, which } from "../util/process.js";

const DEFAULT_MODELS = [
  "default",
  "gpt-5.6-terra",
  "gpt-5.1-codex",
  "o3",
  "o4-mini",
];

/** Delay between fake-streamed content words (ms). */
const CONTENT_WORD_DELAY_MS = 28;

export interface CodexAdapterOptions {
  /** Binary name or path (default: codex) */
  binary?: string;
  /** Working directory for codex exec (default: cwd) */
  cwd?: string;
  /** Extra args appended to `codex exec` */
  extraArgs?: string[];
  /** Request timeout in ms */
  timeoutMs?: number;
  /**
   * Sandbox mode for exec.
   * Default: read-only (safer for API/benchmark prompts that should not mutate disk).
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Skip git repo check (needed outside of git repos) */
  skipGitRepoCheck?: boolean;
  /** Word-by-word delay for content fake-stream (ms). 0 = instant chunks. */
  contentWordDelayMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { code: "ABORT_ERR" }));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { code: "ABORT_ERR" }));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Yield text word-by-word so SSE clients see a typing effect. */
export async function* fakeStreamWords(
  text: string,
  delayMs: number,
  signal?: AbortSignal,
  channel: "content" | "reasoning" = "content",
): AsyncGenerator<ChatEvent> {
  const parts = text.match(/\S+\s*|\s+/g) ?? [text];
  for (const part of parts) {
    if (signal?.aborted) {
      yield { type: "error", message: "Aborted", code: "abort" };
      return;
    }
    if (!part) continue;
    yield { type: "delta", text: part, channel };
    if (delayMs > 0) {
      try {
        await sleep(delayMs, signal);
      } catch {
        yield { type: "error", message: "Aborted", code: "abort" };
        return;
      }
    }
  }
}

function itemTypeOf(item: Record<string, unknown>): string {
  return typeof item.type === "string" ? item.type : "";
}

/** Extract assistant-facing text from a Codex JSONL item, if any. */
function agentMessageText(item: Record<string, unknown>): string | null {
  const itemType = itemTypeOf(item);
  // Current schema uses agent_message; older experimental-json used assistant_message.
  if (itemType !== "agent_message" && itemType !== "assistant_message" && itemType !== "message") {
    return null;
  }
  if (typeof item.text === "string" && item.text) return item.text;
  if (typeof item.content === "string" && item.content) return item.content;
  if (typeof item.message === "string" && item.message) return item.message;
  return null;
}

function reasoningText(item: Record<string, unknown>): string | null {
  if (itemTypeOf(item) !== "reasoning") return null;
  let text = "";
  if (typeof item.text === "string" && item.text) text = item.text;
  else if (typeof item.content === "string" && item.content) text = item.content;
  if (!text) return null;
  // Codex sometimes appends empty HTML comment markers in summary text.
  return text.replace(/<!--\s*-->/g, "").trim() || null;
}

/** Short human-readable breadcrumb for non-message Codex items (reasoning channel). */
function activityBreadcrumb(
  eventType: string,
  item: Record<string, unknown> | null,
): string | null {
  if (eventType === "thread.started") return "thread started\n";
  if (eventType === "turn.started") return "turn started\n";
  if (!item) return null;

  const itemType = itemTypeOf(item);
  if (itemType === "command_execution") {
    const cmd = typeof item.command === "string" ? item.command : "";
    const status = typeof item.status === "string" ? item.status : "";
    if (eventType === "item.started") {
      return cmd ? `running: ${cmd.slice(0, 120)}\n` : "command started\n";
    }
    if (eventType === "item.completed") {
      const code = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
      return cmd ? `done: ${cmd.slice(0, 80)}${code}\n` : `command ${status || "completed"}${code}\n`;
    }
  }
  if (itemType === "file_change" && eventType === "item.completed") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const n = changes.length;
    return n ? `file changes: ${n}\n` : "file change\n";
  }
  if (itemType === "mcp_tool_call") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const server = typeof item.server === "string" ? item.server : "";
    const label = server ? `${server}/${tool}` : tool;
    if (eventType === "item.started") return `mcp: ${label}\n`;
    if (eventType === "item.completed") return `mcp done: ${label}\n`;
  }
  if (itemType === "web_search" && eventType === "item.completed") {
    const q = typeof item.query === "string" ? item.query : "";
    return q ? `web search: ${q.slice(0, 100)}\n` : "web search\n";
  }
  if (itemType === "todo_list" && (eventType === "item.started" || eventType === "item.updated")) {
    return "plan updated\n";
  }
  if (itemType === "error") {
    const msg = typeof item.message === "string" ? item.message : "error item";
    return `${msg}\n`;
  }
  return null;
}

export type CodexLineKind = "content" | "reasoning" | "session" | "done" | "error" | "ignore";

export interface CodexParsedLine {
  kind: CodexLineKind;
  text?: string;
  /** True for model reasoning summaries (fake-stream); false for short status crumbs. */
  fakeStream?: boolean;
  sessionId?: string;
  error?: ChatEvent & { type: "error" };
  done?: ChatEvent & { type: "done" };
}

/**
 * Parse one Codex JSONL line into a typed payload.
 * Content (agent_message) is returned whole — caller fake-streams words.
 * Everything else useful goes to reasoning.
 */
export function parseCodexLine(line: string): CodexParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    if (!trimmed.startsWith("{")) return { kind: "content", text: trimmed };
    return { kind: "ignore" };
  }
  if (!obj || typeof obj !== "object") return { kind: "ignore" };

  const rec = obj as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "";

  if (type === "error") {
    let message = "codex stream error";
    if (typeof rec.message === "string" && rec.message) {
      message = rec.message;
    } else if (rec.error && typeof rec.error === "object") {
      const nested = (rec.error as Record<string, unknown>).message;
      if (typeof nested === "string" && nested) message = nested;
    }
    if (/^Reconnecting\.\.\./i.test(message)) return { kind: "ignore" };
    return { kind: "error", error: { type: "error", message, code: "cli_error" } };
  }

  if (type === "turn.failed") {
    let message = "codex turn failed";
    if (rec.error && typeof rec.error === "object") {
      const nested = (rec.error as Record<string, unknown>).message;
      if (typeof nested === "string" && nested) message = nested;
    }
    return { kind: "error", error: { type: "error", message, code: "turn_failed" } };
  }

  if (type === "turn.completed") {
    const usageRaw = rec.usage;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    if (usageRaw && typeof usageRaw === "object") {
      const u = usageRaw as Record<string, unknown>;
      const prompt = typeof u.input_tokens === "number" ? u.input_tokens : 0;
      const completion = typeof u.output_tokens === "number" ? u.output_tokens : 0;
      usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      };
    }
    return { kind: "done", done: { type: "done", finishReason: "stop", usage } };
  }

  const item =
    rec.item && typeof rec.item === "object" ? (rec.item as Record<string, unknown>) : null;

  // Lifecycle breadcrumbs
  if (type === "thread.started") {
    return typeof rec.thread_id === "string" && rec.thread_id
      ? { kind: "session", sessionId: rec.thread_id }
      : { kind: "ignore" };
  }
  if (type === "turn.started") {
    const crumb = activityBreadcrumb(type, null);
    return crumb ? { kind: "reasoning", text: crumb } : { kind: "ignore" };
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    if (item) {
      const agent = agentMessageText(item);
      if (agent && type === "item.completed") {
        return { kind: "content", text: agent };
      }
      const reason = reasoningText(item);
      if (reason && (type === "item.completed" || type === "item.updated")) {
        const text = reason.endsWith("\n") ? reason : `${reason}\n`;
        return { kind: "reasoning", text, fakeStream: true };
      }
      const crumb = activityBreadcrumb(type, item);
      if (crumb) return { kind: "reasoning", text: crumb, fakeStream: false };
    }
    return { kind: "ignore" };
  }

  if (type === "agent_message" || type === "message") {
    const src = item ?? rec;
    const text = agentMessageText(src);
    if (text) return { kind: "content", text };
    if (typeof rec.message === "string" && rec.message) {
      return { kind: "content", text: rec.message };
    }
  }

  return { kind: "ignore" };
}

/**
 * Map one Codex JSONL event to ChatEvents (content returned as a single delta;
 * prefer parseCodexLine + fakeStreamWords in the live adapter path).
 */
export function chatEventsFromCodexLine(line: string): ChatEvent[] {
  const parsed = parseCodexLine(line);
  if (parsed.kind === "content" && parsed.text) {
    return [{ type: "delta", text: parsed.text, channel: "content" }];
  }
  if (parsed.kind === "reasoning" && parsed.text) {
    return [{ type: "delta", text: parsed.text, channel: "reasoning" }];
  }
  if (parsed.kind === "done" && parsed.done) return [parsed.done];
  if (parsed.kind === "session" && parsed.sessionId) return [{ type: "session", id: parsed.sessionId }];
  if (parsed.kind === "error" && parsed.error) return [parsed.error];
  return [];
}

/** Batch helper kept for tests / non-streaming inspection. */
export function parseCodexJsonl(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  let text = "";
  let lastMessage = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.last_agent_message === "string") {
        lastMessage = obj.last_agent_message;
      }
    } catch {
      // ignore
    }
    for (const ev of chatEventsFromCodexLine(line)) {
      if (ev.type === "delta" && (ev.channel ?? "content") === "content") text += ev.text;
    }
  }
  if (lastMessage) return lastMessage.trim();
  if (text) return text.trim();
  const trimmed = stdout.trim();
  if (trimmed && !trimmed.startsWith("{")) return trimmed;
  return trimmed;
}

function buildExecArgs(
  opts: CodexAdapterOptions,
  req: NormalizedChatRequest,
  sandbox: string,
  skipGitRepoCheck: boolean,
  prompt: string,
): string[] {
  const args = req.nativeSessionId
    ? ["exec", "resume", "--json"]
    : ["exec", "--json", "-s", sandbox];
  if (skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (req.nativeSessionId) args.push("-c", `sandbox_mode=\"${sandbox}\"`);
  // Surface reasoning *summaries* on the JSONL stream (effort alone is not enough).
  args.push(
    "-c",
    "model_reasoning_summary=detailed",
    "-c",
    "model_supports_reasoning_summaries=true",
    "-c",
    "hide_agent_reasoning=false",
  );
  // Optional effort override from OpenAI-shaped request body.
  const rawEffort = req.raw?.reasoning_effort ?? req.raw?.reasoningEffort;
  if (typeof rawEffort === "string" && rawEffort.trim() && rawEffort.trim() !== "none") {
    args.push("-c", `model_reasoning_effort=${rawEffort.trim().toLowerCase()}`);
  }
  // cwd is applied via spawn options only — do not also pass -C (double-resolves relative paths).
  if (req.modelLocal && req.modelLocal !== "default") {
    args.push("-m", req.modelLocal);
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  if (req.nativeSessionId) args.push(req.nativeSessionId);
  args.push(prompt);
  return args;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const sandbox = opts.sandbox ?? "read-only";
  const skipGitRepoCheck = opts.skipGitRepoCheck ?? true;
  const wordDelay =
    typeof opts.contentWordDelayMs === "number" ? opts.contentWordDelayMs : CONTENT_WORD_DELAY_MS;

  return {
    id: "codex",
    description: "OpenAI Codex CLI via `codex exec --json`",

    async listModels(): Promise<ModelInfo[]> {
      return DEFAULT_MODELS.map((m) => ({
        id: `codex/${m}`,
        object: "model" as const,
        created: 0,
        owned_by: "codex",
        description: m === "default" ? "Uses Codex CLI default model" : undefined,
      }));
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `codex binary not found on PATH (looked for "${binary}"). Install Codex CLI or set CLI2API_CODEX_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      const prompt = requestToPrompt(req);
      const args = buildExecArgs(opts, req, sandbox, skipGitRepoCheck, prompt);
      // Fake-stream delays are only for SSE typing effect — skip for non-stream collectors.
      const effectiveWordDelay = req.stream ? wordDelay : 0;

      let sawContent = false;
      let pendingDone: (ChatEvent & { type: "done" }) | null = null;
      let exitCode: number | null = null;
      let timedOut = false;
      let stderr = "";

      try {
        for await (const pev of runCommandLines(path, args, {
          cwd: opts.cwd,
          timeoutMs,
          signal,
          inheritEnv: ["CODEX_HOME"],
        })) {
          if (signal.aborted) {
            yield { type: "error", message: "Aborted", code: "abort" };
            return;
          }

          if (pev.type === "stdout_line") {
            const parsed = parseCodexLine(pev.line);
            if (parsed.kind === "session" && parsed.sessionId) {
              yield { type: "session", id: parsed.sessionId };
            } else if (parsed.kind === "reasoning" && parsed.text) {
              if (parsed.fakeStream) {
                for await (const ev of fakeStreamWords(
                  parsed.text,
                  effectiveWordDelay,
                  signal,
                  "reasoning",
                )) {
                  yield ev;
                  if (ev.type === "error") return;
                }
              } else {
                yield { type: "delta", text: parsed.text, channel: "reasoning" };
              }
            } else if (parsed.kind === "content" && parsed.text) {
              sawContent = true;
              // Fake-stream the whole agent message word-by-word.
              for await (const ev of fakeStreamWords(
                parsed.text,
                effectiveWordDelay,
                signal,
                "content",
              )) {
                yield ev;
                if (ev.type === "error") return;
              }
            } else if (parsed.kind === "done" && parsed.done) {
              // Buffer until exit validation — nonzero exit must not look like success.
              pendingDone = parsed.done;
            } else if (parsed.kind === "error" && parsed.error) {
              yield parsed.error;
              return;
            }
          } else if (pev.type === "exit") {
            exitCode = pev.code;
            timedOut = pev.timedOut;
            stderr = pev.stderr;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", message: `Failed to spawn codex: ${message}`, code: "spawn_error" };
        return;
      }

      if (timedOut) {
        yield { type: "error", message: `codex timed out after ${timeoutMs}ms`, code: "timeout" };
        return;
      }

      if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
        return;
      }

      if (exitCode !== 0) {
        const detail = stderr.trim().slice(0, 2000);
        yield {
          type: "error",
          message: `codex exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
          code: "cli_error",
        };
        return;
      }

      if (!sawContent) {
        yield {
          type: "error",
          message: `codex returned empty output. stderr: ${stderr.trim().slice(0, 1000)}`,
          code: "empty_output",
        };
        return;
      }

      yield pendingDone ?? { type: "done", finishReason: "stop" };
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) {
        return {
          ok: false,
          adapter: "codex",
          details: { binary },
          message: "codex binary not found on PATH",
        };
      }
      const ver = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: ver.code === 0,
        adapter: "codex",
        details: {
          binary: path,
          version: ver.stdout.trim() || ver.stderr.trim(),
          sandbox,
        },
        message: ver.code === 0 ? "codex available" : "codex --version failed",
      };
    },

    async doctor(): Promise<DoctorReport> {
      const checks: DoctorReport["checks"] = [];
      const path = await which(binary);
      checks.push({
        name: "binary-on-path",
        ok: Boolean(path),
        detail: path ?? `missing: ${binary}`,
      });

      let version: string | undefined;
      if (path) {
        const ver = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
        version = (ver.stdout || ver.stderr).trim();
        checks.push({
          name: "version",
          ok: ver.code === 0,
          detail: version || `exit ${ver.code}`,
        });

        const help = await runCommand(path, ["exec", "--help"], { timeoutMs: 8_000 });
        const hasJson = /--json/.test(help.stdout + help.stderr);
        checks.push({
          name: "exec-json-flag",
          ok: hasJson,
          detail: hasJson ? "codex exec --json supported" : "codex exec --json not found in help",
        });
      }

      return {
        adapter: "codex",
        ok: checks.every((c) => c.ok),
        binary: path ?? undefined,
        version,
        checks,
      };
    },
  };
}
