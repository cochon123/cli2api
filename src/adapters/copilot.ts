import { randomUUID } from "node:crypto";
import type { Adapter } from "./types.js";
import type {
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { requestToPrompt } from "../protocol/openai.js";
import { runCommand, which } from "../util/process.js";

export interface CopilotAdapterOptions {
  binary?: string;
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export function createCopilotAdapter(opts: CopilotAdapterOptions = {}): Adapter {
  const binary = opts.binary ?? "copilot";
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    id: "copilot",
    description: "GitHub Copilot CLI programmatic mode (silent, plan-only, remote disabled)",

    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "copilot/default",
        object: "model",
        created: 0,
        owned_by: "github-copilot",
        description: "Uses the Copilot CLI default model; any CLI-supported model may be requested",
      }];
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const path = await which(binary);
      if (!path) {
        yield {
          type: "error",
          message: `copilot binary not found on PATH (looked for "${binary}"). Install GitHub Copilot CLI or set CLI2API_COPILOT_BIN.`,
          code: "binary_missing",
        };
        return;
      }

      const sessionId = req.nativeSessionId ?? (req.sessionId ? randomUUID() : undefined);
      const args = [
        "--prompt", requestToPrompt(req),
        "--silent",
        "--stream=off",
        "--plan",
        "--no-ask-user",
        "--no-auto-update",
        "--no-bash-env",
        "--no-custom-instructions",
        "--no-experimental",
        "--no-remote",
        "--no-remote-export",
        "--disable-builtin-mcps",
        "--disallow-temp-dir",
        "--available-tools=view,glob,grep",
        "--allow-tool=read",
      ];
      if (sessionId) args.push("--session-id", sessionId);
      if (req.modelLocal && req.modelLocal !== "default") args.push("--model", req.modelLocal);
      if (opts.extraArgs?.length) args.push(...opts.extraArgs);

      let result;
      try {
        result = await runCommand(path, args, {
          cwd: opts.cwd,
          timeoutMs,
          signal,
          env: {
            COPILOT_ALLOW_ALL: "false",
            GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "false",
            GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "false",
            GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: "false",
          },
          inheritEnv: ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_HOST", "GITHUB_ENTERPRISE_URL"],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield { type: "error", message: `Failed to spawn copilot: ${message}`, code: "spawn_error" };
        return;
      }

      if (result.timedOut) {
        yield { type: "error", message: `copilot timed out after ${timeoutMs}ms`, code: "timeout" };
        return;
      }
      if (result.outputLimitExceeded) {
        yield { type: "error", message: "copilot exceeded the 4 MiB output safety limit", code: "output_limit" };
        return;
      }
      if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
        return;
      }
      if (result.code !== 0) {
        yield {
          type: "error",
          message: `copilot exited with code ${result.code}: ${result.stderr.trim().slice(0, 2_000)}`,
          code: "cli_error",
        };
        return;
      }
      const text = result.stdout.trim();
      if (!text) {
        yield { type: "error", message: `copilot returned empty output: ${result.stderr.trim().slice(0, 1_000)}`, code: "empty_output" };
        return;
      }

      if (sessionId) yield { type: "session", id: sessionId };
      yield { type: "delta", text, channel: "content" };
      yield { type: "done", finishReason: "stop" };
    },

    async health(): Promise<HealthStatus> {
      const path = await which(binary);
      if (!path) return { ok: false, adapter: "copilot", details: { binary }, message: "copilot binary not found on PATH" };
      const version = await runCommand(path, ["--version"], { timeoutMs: 8_000 });
      return {
        ok: version.code === 0,
        adapter: "copilot",
        details: { binary: path, version: (version.stdout || version.stderr).trim(), mode: "plan", remote: false },
        message: version.code === 0 ? "copilot available" : "copilot --version failed",
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
        checks.push({ name: "programmatic-mode", ok: /--prompt/.test(output) && /--silent/.test(output), detail: "documented scripting flags" });
        checks.push({ name: "plan-mode", ok: /--plan/.test(output), detail: "read-only plan mode" });
        checks.push({
          name: "restrictive-flags",
          ok: [
            "--available-tools", "--disable-builtin-mcps", "--disallow-temp-dir",
            "--no-custom-instructions", "--no-remote", "--no-remote-export", "--stream",
          ].every((flag) => output.includes(flag)),
          detail: "tool allowlist, MCP/remote disable, and buffered output controls",
        });
      }
      return { adapter: "copilot", ok: checks.every((check) => check.ok), binary: path ?? undefined, version, checks };
    },
  };
}
