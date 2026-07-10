import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Soft cap on queued stdout/stderr bytes before pausing child streams. */
const MAX_QUEUED_BYTES = 1_048_576;
/** Keep only the trailing stderr for exit diagnostics. */
const MAX_STDERR_BYTES = 65_536;

export interface RunCommandOptions {
  cwd?: string;
  /** Explicit child environment overrides. These do not re-enable full env inheritance. */
  env?: NodeJS.ProcessEnv;
  /** Additional parent environment variable names to copy into the scrubbed child env. */
  inheritEnv?: string[];
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

/**
 * Environment values needed for a normal local CLI process, without forwarding
 * unrelated API keys and application secrets from the gateway process.
 */
const BASE_CHILD_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

function configuredChildEnvKeys(): string[] {
  return (process.env.CLI2API_CHILD_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

/** Build the allowlisted environment used by every spawned command. */
export function buildChildEnv(
  overrides: NodeJS.ProcessEnv = {},
  inheritEnv: string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const keys = new Set<string>([
    ...BASE_CHILD_ENV_KEYS,
    ...Object.keys(process.env).filter((key) => key === "LC_ALL" || key.startsWith("LC_")),
    ...inheritEnv,
    ...configuredChildEnvKeys(),
  ]);

  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string") result[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") result[key] = value;
    else delete result[key];
  }
  return result;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid) {
      try {
        // Children are spawned as their own process group. Agent CLIs often
        // launch helpers which inherit stdio; killing only the parent leaves
        // those pipes open and prevents the iterator from completing.
        process.kill(-child.pid, name);
        return;
      } catch {
        // The group may already be gone; fall back to the direct child handle.
      }
    }
    child.kill(name);
  };
  signal("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signal("SIGKILL");
    }
  }, 2_000).unref();
}

function appendCapped(buf: string, chunk: string, maxBytes: number): string {
  const next = buf + chunk;
  if (next.length <= maxBytes) return next;
  return next.slice(next.length - maxBytes);
}

function spawnChild(
  command: string,
  args: string[],
  opts: RunCommandOptions,
): SpawnedChild {
  const { cwd, env, inheritEnv, timeoutMs = 120_000, signal, stdin } = opts;

  if (signal?.aborted) {
    throw Object.assign(new Error("Aborted"), { code: "ABORT_ERR" });
  }

  const child = spawn(command, args, {
    cwd,
    env: buildChildEnv(env, inheritEnv),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminateChild(child);
        }, timeoutMs)
      : undefined;

  const onAbort = () => {
    terminateChild(child);
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
  let queuedBytes = 0;
  let streamsPaused = false;
  let wait: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;
  let stderr = "";
  let stdoutBuf = "";

  const eventBytes = (ev: CommandLineEvent): number => {
    if (ev.type === "stdout_line") return ev.line.length;
    if (ev.type === "stderr") return ev.data.length;
    return ev.stderr.length;
  };

  const maybePause = () => {
    if (streamsPaused || queuedBytes < MAX_QUEUED_BYTES) return;
    streamsPaused = true;
    child.stdout.pause();
    child.stderr.pause();
  };

  const maybeResume = () => {
    if (!streamsPaused || queuedBytes >= MAX_QUEUED_BYTES / 2) return;
    streamsPaused = false;
    child.stdout.resume();
    child.stderr.resume();
  };

  const push = (ev: CommandLineEvent) => {
    queue.push(ev);
    queuedBytes += eventBytes(ev);
    maybePause();
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
    stderr = appendCapped(stderr, chunk, MAX_STDERR_BYTES);
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
      queuedBytes = Math.max(0, queuedBytes - eventBytes(ev));
      maybeResume();
      yield ev;
      if (ev.type === "exit") return;
    }
    if (error) throw error;
  } finally {
    dispose();
    // Consumer abandoned the iterator (e.g. client disconnect) — stop the CLI.
    terminateChild(child);
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
