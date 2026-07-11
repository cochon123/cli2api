import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

const REQUESTS = Number(process.env.CLI2API_BENCH_REQUESTS ?? 1_000);
const CONCURRENCY = Number(process.env.CLI2API_BENCH_CONCURRENCY ?? 32);
const TOKEN = "cli2api-local-benchmark-token";

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

async function rssKiB(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(REQUESTS) || REQUESTS < 1 || !Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
    throw new Error("CLI2API_BENCH_REQUESTS and CLI2API_BENCH_CONCURRENCY must be positive integers");
  }

  const startedAt = performance.now();
  const child = spawn(process.execPath, [
    "dist/index.js", "serve",
    "--adapter", "mock",
    "--port", "0",
    "--token", TOKEN,
    "--json",
    "--max-concurrency", "64",
    "--max-queue", "1000",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });

  try {
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server readiness timed out: ${stderr}`)), 10_000);
    const lines = createInterface({ input: child.stdout });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited ${code} before readiness: ${stderr}`)));
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`invalid readiness JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
    const startupMs = performance.now() - startedAt;
    const base = String(ready.openai_base_url);
    const body = JSON.stringify({
      model: "mock/echo",
      messages: [{ role: "user", content: "benchmark" }],
    });
    const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const idleMemory = await rssKiB(child.pid!);

    for (let index = 0; index < 50; index += 1) {
      const response = await fetch(`${base}/chat/completions`, { method: "POST", headers, body });
      if (!response.ok) throw new Error(`warmup failed: HTTP ${response.status}`);
      await response.arrayBuffer();
    }

    const latencies: number[] = [];
    let cursor = 0;
    const benchStarted = performance.now();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= REQUESTS) return;
        const requestStarted = performance.now();
        const response = await fetch(`${base}/chat/completions`, { method: "POST", headers, body });
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        if (!response.ok || !payload.choices?.[0]?.message?.content?.includes("benchmark")) {
          throw new Error(`request ${index} failed: HTTP ${response.status}`);
        }
        latencies.push(performance.now() - requestStarted);
      }
    }));
    const elapsedMs = performance.now() - benchStarted;
    latencies.sort((a, b) => a - b);
    const memory = await rssKiB(child.pid!);
    process.stdout.write(JSON.stringify({
      schema: "cli2api-benchmark-v1",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      cold_start_ms: Number(startupMs.toFixed(1)),
      requests_per_second: Number((REQUESTS / (elapsedMs / 1_000)).toFixed(1)),
      latency_ms: {
        p50: Number(percentile(latencies, 0.50).toFixed(2)),
        p95: Number(percentile(latencies, 0.95).toFixed(2)),
        p99: Number(percentile(latencies, 0.99).toFixed(2)),
      },
      server_rss_mib: memory == null ? null : Number((memory / 1_024).toFixed(1)),
      idle_server_rss_mib: idleMemory == null ? null : Number((idleMemory / 1_024).toFixed(1)),
    }, null, 2) + "\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
