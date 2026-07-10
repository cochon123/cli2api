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

    // Chat Completions function calling
    const toolCompletion = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo",
        messages: [{ role: "user", content: "weather in Edmonton" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        tool_choice: "required",
      }),
    }).then((r) => r.json());
    assert(toolCompletion.choices?.[0]?.finish_reason === "tool_calls", "tool finish reason");
    assert(toolCompletion.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "get_weather", "chat tool call");

    // Responses API non-stream + previous_response_id session chain
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", input: "responses-ping" }),
    }).then((r) => r.json());
    assert(response.object === "response" && response.status === "completed", "response object");
    assert(response.output?.[0]?.content?.[0]?.text?.includes("responses-ping"), "response text");

    const resumed = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", input: "second-turn", previous_response_id: response.id }),
    }).then((r) => r.json());
    assert(resumed.id !== response.id && resumed.status === "completed", "response session chain");

    // Responses semantic SSE events and function call events
    const responseStream = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo", stream: true, input: "call tool",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        tool_choice: "required",
      }),
    }).then((r) => r.text());
    assert(responseStream.includes("response.created"), "response.created event");
    assert(responseStream.includes("response.function_call_arguments.done"), "function arguments event");
    assert(responseStream.includes("response.completed"), "response.completed event");

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
