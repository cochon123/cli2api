import { spawn } from "node:child_process";

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

export function runCommand(
  command: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { cwd, env, timeoutMs = 120_000, signal, stdin } = opts;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { code: "ABORT_ERR" }));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      // TODO(P1): scrub parent env — today children inherit the full process.env.
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (stdin != null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/** Resolve a binary from PATH; returns absolute path or null. No shell involved. */
export async function which(binary: string): Promise<string | null> {
  const result = await runCommand("which", [binary], { timeoutMs: 5_000 });
  const path = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return result.code === 0 && path ? path : null;
}
