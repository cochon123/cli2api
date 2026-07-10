import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface RunCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandLineEvent =
  | { type: "stdout_line"; line: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; timedOut: boolean; stderr: string };

interface SpawnedChild {
  child: ChildProcessWithoutNullStreams;
  timedOut: () => boolean;
  dispose: () => void;
}

function spawnChild(
  command: string,
  args: string[],
  opts: RunCommandOptions,
): SpawnedChild {
  const { cwd, env, timeoutMs = 120_000, signal, stdin } = opts;

  if (signal?.aborted) {
    throw Object.assign(new Error("Aborted"), { code: "ABORT_ERR" });
  }

  const child = spawn(command, args, {
    cwd,
    // TODO(P1): scrub parent env — today children inherit the full process.env.
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, timeoutMs)
      : undefined;

  const onAbort = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  if (stdin != null) {
    child.stdin.write(stdin);
  }
  child.stdin.end();

  return {
    child,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export function runCommand(
  command: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    let spawned: SpawnedChild;
    try {
      spawned = spawnChild(command, args, opts);
    } catch (err) {
      reject(err);
      return;
    }

    const { child, timedOut, dispose } = spawned;
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      dispose();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      dispose();
      resolve({ code, stdout, stderr, timedOut: timedOut() });
    });
  });
}

/**
 * Spawn a process and yield complete stdout lines as they arrive (JSONL-friendly).
 * Stderr is accumulated and also emitted as chunks; final exit includes full stderr.
 */
export async function* runCommandLines(
  command: string,
  args: string[],
  opts: RunCommandOptions = {},
): AsyncGenerator<CommandLineEvent> {
  let spawned: SpawnedChild;
  try {
    spawned = spawnChild(command, args, opts);
  } catch (err) {
    throw err;
  }

  const { child, timedOut, dispose } = spawned;
  const queue: CommandLineEvent[] = [];
  let wait: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;
  let stderr = "";
  let stdoutBuf = "";

  const push = (ev: CommandLineEvent) => {
    queue.push(ev);
    if (wait) {
      const w = wait;
      wait = null;
      w();
    }
  };

  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      let line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      push({ type: "stdout_line", line });
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    push({ type: "stderr", data: chunk });
  });

  child.on("error", (err) => {
    error = err;
    done = true;
    if (wait) {
      const w = wait;
      wait = null;
      w();
    }
  });

  child.on("close", (code) => {
    if (stdoutBuf.length) {
      let line = stdoutBuf;
      stdoutBuf = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      push({ type: "stdout_line", line });
    }
    push({ type: "exit", code, timedOut: timedOut(), stderr });
    done = true;
    dispose();
    if (wait) {
      const w = wait;
      wait = null;
      w();
    }
  });

  try {
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wait = resolve;
        });
        continue;
      }
      const ev = queue.shift()!;
      yield ev;
      if (ev.type === "exit") return;
    }
    if (error) throw error;
  } finally {
    dispose();
    // Consumer abandoned the iterator (e.g. client disconnect) — stop the CLI.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

/** Resolve a binary from PATH; returns absolute path or null. No shell involved. */
export async function which(binary: string): Promise<string | null> {
  try {
    const result = await runCommand("which", [binary], { timeoutMs: 5_000 });
    const path = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    return result.code === 0 && path ? path : null;
  } catch {
    // Missing `which` binary (or spawn failure) → treat as not found.
    return null;
  }
}
