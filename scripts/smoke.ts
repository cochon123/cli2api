/**
 * Phase 0 smoke test:
 * 1. Start server with mock adapter + required bearer token
 * 2. Hit /health, /v1/models, /v1/chat/completions (stream + non-stream)
 * 3. Confirm unauthenticated requests are rejected
 * 4. Exit non-zero on failure
 */
import { createRegistry } from "../src/adapters/registry.js";
import { listen } from "../src/server/listen.js";

const PORT = 13927;
const TOKEN = "smoke-test-token";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function main() {
  const registry = createRegistry({ defaultAdapter: "mock" });
  const server = await listen({
    registry,
    host: "127.0.0.1",
    port: PORT,
    token: TOKEN,
    verbose: false,
  });
  const base = `http://127.0.0.1:${PORT}`;

  try {
    const denied = await fetch(`${base}/health`);
    assert(denied.status === 401, "unauthenticated health must be 401");

    const health = await fetch(`${base}/health`, { headers: authHeaders() }).then((r) => r.json());
    assert(health.ok === true, "health.ok");

    const models = await fetch(`${base}/v1/models`, { headers: authHeaders() }).then((r) => r.json());
    assert(Array.isArray(models.data) && models.data.length >= 2, "models.data");
    assert(
      models.data.some((m: { id: string }) => m.id === "mock/echo"),
      "mock/echo listed",
    );

    // Non-stream
    const completion = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo",
        messages: [{ role: "user", content: "ping-from-smoke" }],
      }),
    }).then((r) => r.json());

    const content = completion.choices?.[0]?.message?.content as string;
    assert(typeof content === "string" && content.includes("ping-from-smoke"), "echo content");
    assert(completion.object === "chat.completion", "object chat.completion");

    // Stream
    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo",
        stream: true,
        messages: [{ role: "user", content: "stream-me" }],
      }),
    });
    assert(streamRes.ok, `stream status ${streamRes.status}`);
    const raw = await streamRes.text();
    assert(raw.includes("data:"), "sse data lines");
    assert(raw.includes("[DONE]"), "sse done");
    assert(raw.includes("stream-me"), "streamed echo");

    console.log("smoke ok");
    console.log(`  non-stream: ${content.slice(0, 80)}`);
    console.log(`  stream bytes: ${raw.length}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("smoke FAILED:", err);
  process.exit(1);
});
