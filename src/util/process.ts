import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

/** Soft cap on queued stdout/stderr bytes before pausing child streams. */
const MAX_QUEUED_BYTES = 1_048_576;
/** Keep only the trailing stderr for exit diagnostics. */
const MAX_STDERR_BYTES = 65_536;
/** A CLI response must not be able to grow the gateway heap without bound. */
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1_048_576;
/** JSONL protocols require bounded individual records as well as a bounded queue. */
const MAX_STDOUT_LINE_BYTES = 4 * 1_048_576;
/** Bound raw JSONL traffic too, including records an adapter ignores. */
const MAX_STREAM_OUTPUT_BYTES = 8 * 1_048_576;

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
  outputLimitExceeded: boolean;
}

export type CommandLineEvent =
  | { type: "stdout_line"; line: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; timedOut: boolean; stderr: string; outputLimitExceeded: boolean };

interface SpawnedChild {
  child: ChildProcessWithoutNullStreams;
  timedOut: () => boolean;
  dispose: () => void;
}

const terminatingChildren = new WeakSet<ChildProcess>();

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
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
] as const;

function windowsSystemBinary(relativePath: string): string | undefined {
  const root = process.env.SystemRoot || process.env.windir;
  return root && isAbsolute(root) ? join(root, "System32", relativePath) : undefined;
}

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

/** Kill a CLI process tree without invoking a shell. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      const taskkill = windowsSystemBinary("taskkill.exe");
      if (!taskkill) throw new Error("SystemRoot is unavailable");
      const killer = spawn(taskkill, args, {
        stdio: "ignore",
        windowsHide: true,
        env: buildChildEnv(),
      });
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
        }
      };
      killer.once("error", fallback);
      killer.once("exit", (code) => { if (code !== 0) fallback(); });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct child handle if taskkill cannot start.
    }
  } else {
    try {
      // Adapter children are detached into their own POSIX process group.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child handle.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (terminatingChildren.has(child)) return;
  terminatingChildren.add(child);
  let closed = false;
  child.once("close", () => { closed = true; });
  killProcessTree(child, "SIGTERM");
  setTimeout(() => {
    // The group may outlive its leader and keep inherited stdout/stderr open.
    // POSIX can safely address the still-owned process group after its leader
    // exits. Windows taskkill is best effort and is forced while the PID is
    // still known to belong to the original tree.
    if (process.platform !== "win32" || !closed) killProcessTree(child, "SIGKILL");
  }, 2_000);
}

/** Ensure local SDK traffic cannot be routed through an inherited proxy. */
export function loopbackNoProxy(env: NodeJS.ProcessEnv = process.env): string {
  const values = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost", "::1", "[::1]"]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].join(",");
}

function appendCapped(buf: string, chunk: string, maxBytes: number): string {
  const next = buf + chunk;
  if (Buffer.byteLength(next) <= maxBytes) return next;
  const bytes = Buffer.from(next);
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
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

  const prepared = prepareSpawnCommand(command, args);

  const child = spawn(prepared.command, prepared.args, {
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

export function prepareSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
  let executable = command;
  let executableArgs = args;
  if (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(command)) {
    // npm creates a sibling PowerShell shim for every .cmd executable. Invoke
    // that file with PowerShell's -File mode so model-controlled prompt text is
    // passed as argv, never parsed as a cmd.exe command string.
    const powershellShim = /\.ps1$/i.test(command)
      ? command
      : command.replace(/\.(?:cmd|bat)$/i, ".ps1");
    const powershell = windowsSystemBinary(join("WindowsPowerShell", "v1.0", "powershell.exe"));
    if (!powershell || !existsSync(powershellShim)) {
      throw new Error(`Refusing to execute Windows batch shim without a sibling PowerShell launcher: ${command}`);
    }
    executable = powershell;
    executableArgs = [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", powershellShim, ...args,
    ];
  }
  return { command: executable, args: executableArgs };
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
    let outputBytes = 0;
    let outputLimitExceeded = false;

    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stdout = appendCapped(stdout, chunk, MAX_COMMAND_OUTPUT_BYTES);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminateChild(child);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stderr = appendCapped(stderr, chunk, MAX_STDERR_BYTES);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminateChild(child);
      }
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
      resolve({ code, stdout, stderr, timedOut: timedOut(), outputLimitExceeded });
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
  let stdoutLineBytes = 0;
  let outputLimitExceeded = false;
  let totalOutputBytes = 0;
  let exitConsumed = false;

  const eventBytes = (ev: CommandLineEvent): number => {
    if (ev.type === "stdout_line") return Buffer.byteLength(ev.line);
    if (ev.type === "stderr") return Buffer.byteLength(ev.data);
    return Buffer.byteLength(ev.stderr);
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

  const exceedOutputLimit = (message: string) => {
    if (outputLimitExceeded) return;
    outputLimitExceeded = true;
    stdoutBuf = "";
    stderr = appendCapped(stderr, `\ncli2api: ${message}`, MAX_STDERR_BYTES);
    terminateChild(child);
  };

  child.stdout.on("data", (chunk: string) => {
    if (outputLimitExceeded) return;
    totalOutputBytes += Buffer.byteLength(chunk);
    if (totalOutputBytes > MAX_STREAM_OUTPUT_BYTES) {
      exceedOutputLimit(`${MAX_STREAM_OUTPUT_BYTES}-byte total process output limit exceeded`);
      return;
    }
    stdoutBuf += chunk;
    stdoutLineBytes += Buffer.byteLength(chunk);
    if (stdoutLineBytes > MAX_STDOUT_LINE_BYTES && !stdoutBuf.includes("\n")) {
      exceedOutputLimit(`${MAX_STDOUT_LINE_BYTES}-byte JSONL record limit exceeded`);
      return;
    }
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      let line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      stdoutLineBytes = Buffer.byteLength(stdoutBuf);
      if (Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES) {
        exceedOutputLimit(`${MAX_STDOUT_LINE_BYTES}-byte JSONL record limit exceeded`);
        return;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      push({ type: "stdout_line", line });
    }
  });

  child.stderr.on("data", (chunk: string) => {
    if (outputLimitExceeded) return;
    totalOutputBytes += Buffer.byteLength(chunk);
    if (totalOutputBytes > MAX_STREAM_OUTPUT_BYTES) {
      exceedOutputLimit(`${MAX_STREAM_OUTPUT_BYTES}-byte total process output limit exceeded`);
      return;
    }
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
    push({ type: "exit", code, timedOut: timedOut(), stderr, outputLimitExceeded });
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
      if (ev.type === "exit") {
        exitConsumed = true;
        return;
      }
    }
    if (error) throw error;
  } finally {
    dispose();
    // Consumer abandoned the iterator (e.g. client disconnect) — stop the CLI.
    // A normally consumed exit already means Node observed all stdio closing.
    if (!exitConsumed) terminateChild(child);
  }
}

/** Resolve a binary from PATH; returns absolute path or null. No shell involved. */
export async function which(binary: string): Promise<string | null> {
  if (!binary.trim()) return null;
  const hasPath = isAbsolute(binary) || binary.includes("/") || binary.includes("\\");
  const directories = hasPath
    ? [""]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => {
        const trimmed = directory.trim();
        return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed || ".";
      });
  const supportedWindowsExtensions = new Set([".COM", ".EXE", ".BAT", ".CMD", ".PS1"]);
  const extensions = process.platform === "win32" && !extname(binary)
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim().toUpperCase())
        .filter((extension) => supportedWindowsExtensions.has(extension))
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory ? join(directory, `${binary}${extension}`) : `${binary}${extension}`);
      try {
        await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}
