/**
 * Phase 0 smoke test:
 * 1. Start server with mock adapter + required bearer token
 * 2. Hit /health, /v1/models, /v1/chat/completions (stream + non-stream)
 * 3. Confirm unauthenticated requests are rejected
 * 4. Exit non-zero on failure
 */
import { createRegistry } from "../src/adapters/registry.js";
import type { Adapter } from "../src/adapters/types.js";
import { listen } from "../src/server/listen.js";

const TOKEN = "smoke-test-token";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function sessionFixtureAdapter(id: string): Adapter {
  return {
    id,
    description: `${id} session namespace fixture`,
    async listModels() {
      return [{ id: `${id}/default`, object: "model", created: 0, owned_by: "test" }];
    },
    async *chat(req) {
      yield { type: "delta", text: req.nativeSessionId ?? `${id}:fresh`, channel: "content" };
      yield { type: "session", id: `${id}:native` };
      yield { type: "done", finishReason: "stop" };
    },
    async health() { return { ok: true, adapter: id, details: {} }; },
    async doctor() { return { adapter: id, ok: true, checks: [{ name: "fixture", ok: true }] }; },
  };
}

async function main() {
  const registry = createRegistry({
    defaultAdapter: "mock",
    modelRoutes: { "openai/gpt-local-test": { adapter: "mock", model: "echo" } },
  });
  registry.register(sessionFixtureAdapter("session-a"));
  registry.register(sessionFixtureAdapter("session-b"));
  const server = await listen({
    registry,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    verbose: false,
    openRouter: {
      defaultModel: "openai/gpt-local-test",
      mode: "runnable",
      fetchImpl: async () => new Response(JSON.stringify({ data: [{
        id: "openai/gpt-local-test",
        canonical_slug: "openai/gpt-local-test",
        name: "GPT Local Test",
        description: "Upstream metadata fixture",
        context_length: 12345,
        supported_parameters: ["tools", "tool_choice", "reasoning", "temperature"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      }] }), { headers: { "Content-Type": "application/json" } }),
      metadataCachePath: `/tmp/cli2api-smoke-openrouter-models-${process.pid}.json`,
      metadataTtlSeconds: 60,
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    const denied = await fetch(`${base}/health`);
    assert(denied.status === 401, "unauthenticated health must be 401");
    assert(denied.headers.get("cache-control") === "no-store", "security cache header");
    assert(denied.headers.get("x-content-type-options") === "nosniff", "security content-type header");

    const openRouterDenied = await fetch(`${base}/api/v1/models`).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert(openRouterDenied.status === 401 && openRouterDenied.body.error?.code === 401, "OpenRouter authentication error shape");

    const health = await fetch(`${base}/health`, { headers: authHeaders() }).then((r) => r.json());
    assert(health.ok === true, "health.ok");

    const models = await fetch(`${base}/v1/models`, { headers: authHeaders() }).then((r) => r.json());
    assert(Array.isArray(models.data) && models.data.length >= 2, "models.data");
    assert(
      models.data.some((m: { id: string }) => m.id === "mock/echo"),
      "mock/echo listed",
    );

    const openRouterModels = await fetch(`${base}/api/v1/models`, { headers: authHeaders() }).then((r) => r.json());
    const routedModel = openRouterModels.data.find((m: { id: string }) => m.id === "openai/gpt-local-test");
    assert(routedModel?.name === "GPT Local Test", "OpenRouter metadata merged into routed model");
    assert(routedModel?.context_length === 12345, "OpenRouter context metadata preserved");
    assert(routedModel?.cli2api?.available === true, "routed model annotated available");
    assert(!routedModel.supported_parameters.includes("temperature"), "unsupported local parameter removed");

    const openRouterCompletion = await fetch(`${base}/api/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "openai/gpt-local-test",
        messages: [{ role: "user", content: "openrouter-ping" }],
        reasoning: { effort: "low" },
      }),
    }).then((r) => r.json());
    assert(openRouterCompletion.id.startsWith("gen-"), "OpenRouter generation id");
    assert(openRouterCompletion.model === "openai/gpt-local-test", "public model id preserved");
    assert(openRouterCompletion.choices[0].native_finish_reason === "stop", "native finish reason");
    assert(openRouterCompletion.choices[0].message.reasoning === "mock reasoning", "non-stream reasoning");

    const defaultModelCompletion = await fetch(`${base}/api/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "default-model" }] }),
    }).then((r) => r.json());
    assert(defaultModelCompletion.model === "openai/gpt-local-test", "configured OpenRouter default model");

    const openRouterStream = await fetch(`${base}/api/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "openai/gpt-local-test",
        stream: true,
        messages: [{ role: "user", content: "openrouter-stream" }],
        include_reasoning: true,
      }),
    }).then((r) => r.text());
    const openRouterChunks = openRouterStream.split("\n")
      .filter((line) => line.startsWith("data: {") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)));
    assert(openRouterChunks.some((chunk) => chunk.choices?.[0]?.delta?.reasoning), "stream reasoning delta");
    assert(openRouterChunks.some((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage?.total_tokens), "final empty-choice usage chunk");

    const unavailable = await fetch(`${base}/api/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "google/unmapped", messages: [{ role: "user", content: "x" }] }),
    });
    const unavailableBody = await unavailable.json();
    assert(unavailable.status === 400 && unavailableBody.error?.code === 400, "unmapped mirrored model status code");
    assert(unavailableBody.error?.metadata?.error_type === "invalid_request", "unmapped model OpenRouter error type");
    assert(unavailableBody.error?.metadata?.cli2api_code === "model_not_available", "unmapped model local error detail");

    const openRouterResponse = await fetch(`${base}/api/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "openai/gpt-local-test", input: "openrouter-response" }),
    }).then((r) => r.json());
    assert(openRouterResponse.object === "response" && openRouterResponse.model === "openai/gpt-local-test", "OpenRouter Responses path and public model");

    // Anthropic Messages compatibility and x-api-key authentication.
    const anthropicDenied = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock/echo", max_tokens: 64, messages: [{ role: "user", content: "x" }] }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert(anthropicDenied.status === 401 && anthropicDenied.body.type === "error", "Anthropic authentication error shape");

    const anthropic = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": TOKEN, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock/echo", max_tokens: 64,
        system: "Be concise",
        messages: [{ role: "user", content: "anthropic-ping" }],
        thinking: { type: "enabled", budget_tokens: 16 },
      }),
    }).then((response) => response.json());
    assert(anthropic.type === "message" && anthropic.role === "assistant", "Anthropic message response");
    assert(anthropic.content.some((block: { type: string; text?: string }) => block.type === "text" && block.text?.includes("anthropic-ping")), "Anthropic text block");
    assert(anthropic.content.some((block: { type: string }) => block.type === "thinking"), "Anthropic thinking block");

    const anthropicStream = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock/echo", max_tokens: 64, stream: true, messages: [{ role: "user", content: "anthropic-stream" }] }),
    }).then((response) => response.text());
    for (const event of ["message_start", "content_block_start", "content_block_delta", "message_delta", "message_stop"]) {
      assert(anthropicStream.includes(`event: ${event}`), `missing Anthropic ${event}`);
    }

    const anthropicTool = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock/echo", max_tokens: 64,
        messages: [{ role: "user", content: "lookup weather" }],
        tools: [{ name: "lookup", input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } }],
        tool_choice: { type: "any" },
      }),
    }).then((response) => response.json());
    assert(anthropicTool.stop_reason === "tool_use", "Anthropic tool stop reason");
    assert(anthropicTool.content.some((block: { type: string; name?: string }) => block.type === "tool_use" && block.name === "lookup"), "Anthropic tool block");

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
        tools: [{ type: "function", function: {
          name: "get_weather", strict: true,
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
        } }],
        tool_choice: "required",
      }),
    }).then((r) => r.json());
    assert(toolCompletion.choices?.[0]?.finish_reason === "tool_calls", "tool finish reason");
    assert(toolCompletion.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "get_weather", "chat tool call");

    const sharedSession = "same-public-key";
    const sessionTurn = async (model: string) => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model, session_id: sharedSession, messages: [{ role: "user", content: "x" }] }),
    }).then((response) => response.json());
    assert((await sessionTurn("session-a/default")).choices[0].message.content === "session-a:fresh", "first adapter session starts fresh");
    assert((await sessionTurn("session-b/default")).choices[0].message.content === "session-b:fresh", "same public key is isolated across adapters");
    assert((await sessionTurn("session-a/default")).choices[0].message.content === "session-a:native", "first adapter session mapping is not overwritten");

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
    const collidingChat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo",
        session_id: response.id,
        messages: [{ role: "user", content: "chat-must-not-revive-response-id" }],
      }),
    });
    assert(collidingChat.ok, "Chat may use a response-shaped session key in its own namespace");
    const reusedPrevious = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", input: "must-not-branch", previous_response_id: response.id }),
    });
    assert(reusedPrevious.status === 400, "Chat session keys must not revive a consumed Responses id");

    const chatOnlyResponseId = "resp_aaaaaaaaaaaaaaaaaaaaaaaa";
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo",
        session_id: chatOnlyResponseId,
        messages: [{ role: "user", content: "chat-only-session" }],
      }),
    });
    const crossProtocolPrevious = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", input: "must-not-cross", previous_response_id: chatOnlyResponseId }),
    });
    assert(crossProtocolPrevious.status === 400, "Responses must not consume a Chat session mapping");

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
    const responseEvents = responseStream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; sequence_number: number });
    assert(responseEvents[0]?.type === "response.created", "response stream starts created");
    assert(responseEvents[1]?.type === "response.in_progress", "response stream enters in_progress");
    assert(responseEvents.every((event, index) => event.sequence_number === index), "response sequence numbers");

    const completedStreamEvent = responseStream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; response?: { id?: string } })
      .find((event) => event.type === "response.completed");
    const streamedResponseId = completedStreamEvent?.response?.id;
    assert(typeof streamedResponseId === "string", "streamed response exposes a resumable id only on completion");
    const resumedStream = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", input: "after-stream", previous_response_id: streamedResponseId }),
    }).then((r) => r.json());
    assert(resumedStream.status === "completed", "completed stream response id resumes");

    const textResponseStream = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", stream: true, input: "text lifecycle" }),
    }).then((r) => r.text());
    for (const event of ["response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done"]) {
      assert(textResponseStream.includes(event), `missing ${event}`);
    }

    const missingPrevious = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", input: "lost", previous_response_id: "resp_missing" }),
    });
    assert(missingPrevious.status === 400, "unknown previous_response_id must be 400");

    const malformedTool = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo", messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { parameters: { type: "object" } } }], tool_choice: "required",
      }),
    });
    assert(malformedTool.status === 400, "malformed required tool must be 400");

    const strictMismatch = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo", messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: {
          name: "needs_city", strict: true,
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
        } }], tool_choice: "required",
      }),
    });
    assert(strictMismatch.status === 502, "strict native tool mismatch must be rejected");

    const invalidSchema = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "mock/echo", messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "bad", strict: true, parameters: { type: "not-a-json-type" } } }],
      }),
    });
    assert(invalidSchema.status === 400, "invalid strict schema must be 400");

    const malformedMessage = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", messages: [null] }),
    });
    assert(malformedMessage.status === 400, "malformed message must be 400");

    const oversized = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "mock/echo", messages: [{ role: "user", content: "x".repeat(2 * 1_048_576) }] }),
    });
    assert(oversized.status === 413, "oversized body must be rejected before parsing");

    console.log("smoke ok");
    console.log(`  non-stream: ${content.slice(0, 80)}`);
    console.log(`  stream bytes: ${raw.length}`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error("smoke FAILED:", err);
  process.exit(1);
});
