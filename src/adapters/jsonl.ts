import type { ChatEvent, NormalizedChatRequest } from "../types.js";
import { runCommandLines, type CommandLineEvent } from "../util/process.js";

export interface JsonlCommandOptions {
  label: string;
  binary: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  signal: AbortSignal;
  inheritEnv?: string[];
  env?: NodeJS.ProcessEnv;
  parseLine: (line: string) => ChatEvent[];
  request: NormalizedChatRequest;
}

/**
 * Shared lifecycle for CLIs that expose newline-delimited JSON. Parsers remain
 * adapter-specific, while process limits, abort handling, and exit validation
 * stay identical across providers.
 */
export async function* streamJsonlCommand(
  opts: JsonlCommandOptions,
): AsyncGenerator<ChatEvent> {
  let sawContent = false;
  let sawToolCall = false;
  let pendingDone: (ChatEvent & { type: "done" }) | undefined;
  let exit: Extract<CommandLineEvent, { type: "exit" }> | undefined;

  try {
    for await (const processEvent of runCommandLines(opts.binary, opts.args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      inheritEnv: opts.inheritEnv,
      env: opts.env,
    })) {
      if (opts.signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
        return;
      }

      if (processEvent.type === "stdout_line") {
        for (const event of opts.parseLine(processEvent.line)) {
          if (event.type === "delta" && (event.channel ?? "content") === "content" && event.text) {
            sawContent = true;
          } else if (event.type === "tool_call") {
            sawToolCall = true;
          } else if (event.type === "done") {
            // A non-zero process exit must never be reported as a successful API call.
            pendingDone = event;
            continue;
          } else if (event.type === "error") {
            yield event;
            return;
          }
          yield event;
        }
      } else if (processEvent.type === "exit") {
        exit = processEvent;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield {
      type: "error",
      message: `Failed to spawn ${opts.label}: ${message}`,
      code: "spawn_error",
    };
    return;
  }

  if (exit?.timedOut) {
    yield {
      type: "error",
      message: `${opts.label} timed out after ${opts.timeoutMs}ms`,
      code: "timeout",
    };
    return;
  }
  if (exit?.outputLimitExceeded) {
    yield {
      type: "error",
      message: `${opts.label} exceeded the 8 MiB raw process output safety limit`,
      code: "output_limit",
    };
    return;
  }
  if (opts.signal.aborted) {
    yield { type: "error", message: "Aborted", code: "abort" };
    return;
  }
  if (!exit || exit.code !== 0) {
    const detail = exit?.stderr.trim().slice(0, 2_000) ?? "process closed without an exit event";
    yield {
      type: "error",
      message: `${opts.label} exited with code ${exit?.code ?? "unknown"}${detail ? `: ${detail}` : ""}`,
      code: "cli_error",
    };
    return;
  }
  if (!sawContent && !sawToolCall) {
    yield {
      type: "error",
      message: `${opts.label} returned empty output. stderr: ${exit.stderr.trim().slice(0, 1_000)}`,
      code: "empty_output",
    };
    return;
  }

  yield pendingDone ?? { type: "done", finishReason: sawToolCall ? "tool_calls" : "stop" };
}
