import type { Adapter } from "./types.js";
import type {
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { messagesToPrompt } from "../protocol/openai.js";
import { runCommand, which } from "../util/process.js";

const DEFAULT_MODELS = ["default", "gpt-5.1-codex", "o3", "o4-mini"];

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
}

function parseCodexJsonl(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  let lastMessage = "";
  let agentMessages: string[] = [];

  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    const type = typeof rec.type === "string" ? rec.type : "";

    // Codex JSONL event shapes vary by version; collect common ones.
    if (type === "item.completed" || type === "agent_message" || type === "message") {
      const item = (rec.item ?? rec) as Record<string, unknown>;
      const text =
        (typeof item.text === "string" && item.text) ||
        (typeof item.content === "string" && item.content) ||
        (typeof rec.text === "string" && rec.text) ||
        "";
      if (text) agentMessages.push(text);
    }

    if (type === "agent_message" && typeof rec.message === "string") {
      agentMessages.push(rec.message);
    }

    // Nested: { type: "...", item: { type: "agent_message", text: "..." } }
    if (rec.item && typeof rec.item === "object") {
      const item = rec.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        agentMessages.push(item.text);
      }
      if (typeof item.text === "string" && (item.type === "message" || !item.type)) {
        agentMessages.push(item.text);
      }
    }

    if (typeof rec.last_agent_message === "string") {
      lastMessage = rec.last_agent_message;
    }
  }

  if (lastMessage) return lastMessage.trim();
  if (agentMessages.length) return agentMessages[agentMessages.length - 1].trim();

  // Fallback: if no JSON parsed, use raw stdout (non --json runs)
  const trimmed = stdout.trim();
  if (trimmed && !trimmed.startsWith("{")) return trimmed;
  return trimmed;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const sandbox = opts.sandbox ?? "read-only";
  const skipGitRepoCheck = opts.skipGitRepoCheck ?? true;

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

      const prompt = messagesToPrompt(req.messages);
      const args = ["exec", "--json", "-s", sandbox];
      if (skipGitRepoCheck) args.push("--skip-git-repo-check");
      if (opts.cwd) args.push("-C", opts.cwd);
      if (req.modelLocal && req.modelLocal !== "default") {
        args.push("-m", req.modelLocal);
      }
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);
      // Prompt as positional; also support stdin via "-"
      args.push(prompt);

      let result;
      try {
        result = await runCommand(path, args, {
          cwd: opts.cwd,
          timeoutMs,
          signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", message: `Failed to spawn codex: ${message}`, code: "spawn_error" };
        return;
      }

      if (result.timedOut) {
        yield { type: "error", message: `codex timed out after ${timeoutMs}ms`, code: "timeout" };
        return;
      }

      if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
        return;
      }

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim().slice(0, 2000);
        yield {
          type: "error",
          message: `codex exited with code ${result.code}${detail ? `: ${detail}` : ""}`,
          code: "cli_error",
        };
        return;
      }

      const text = parseCodexJsonl(result.stdout) || result.stdout.trim();
      if (!text) {
        yield {
          type: "error",
          message: `codex returned empty output. stderr: ${(result.stderr || "").trim().slice(0, 1000)}`,
          code: "empty_output",
        };
        return;
      }

      // Fake-stream final answer so SSE clients work
      const chunkSize = 48;
      for (let i = 0; i < text.length; i += chunkSize) {
        if (signal.aborted) {
          yield { type: "error", message: "Aborted", code: "abort" };
          return;
        }
        yield { type: "delta", text: text.slice(i, i + chunkSize) };
      }
      yield { type: "done", finishReason: "stop" };
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
