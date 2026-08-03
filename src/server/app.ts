import { timingSafeEqual } from "node:crypto";
import { Hono, type Handler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AdapterRegistry } from "../adapters/registry.js";
import { collectChatText } from "../adapters/types.js";
import type { ChatCompletionRequest } from "../types.js";
import { transformToolEvents } from "../protocol/tools.js";
import { SessionStore } from "../session.js";
import { OpenRouterCatalog, type OpenRouterCatalogOptions } from "../openrouter/catalog.js";
import {
  buildResponse,
  functionOutput,
  messageOutput,
  responseId,
  responsesToChat,
  type ResponsesRequest,
} from "../protocol/responses.js";
import {
  buildChunk,
  buildCompletionResponse,
  completionId,
  normalizeChatRequest,
  sseLine,
} from "../protocol/openai.js";

export interface ServerOptions {
  registry: AdapterRegistry;
  /** Preferred adapter when model has no prefix */
  adapter?: string;
  /**
   * Required bearer token. Every request must send `Authorization: Bearer <token>`.
   * No CORS middleware: SDK/script clients don't need it; open CORS would let any
   * same-machine browser tab call the gateway.
   */
  token: string;
  /** Log requests to stderr */
  verbose?: boolean;
  openRouter?: OpenRouterServerOptions;
}

export interface OpenRouterServerOptions extends OpenRouterCatalogOptions {
  /** Local equivalent of OpenRouter's account-level default model. */
  defaultModel?: string;
}

function openRouterError(message: string, code: number, errorType: string, metadata: Record<string, unknown> = {}) {
  return {
    error: {
      code,
      message,
      metadata: { error_type: errorType, ...metadata },
    },
  };
}

function unauthorized(openRouter = false) {
  const body = openRouter
    ? openRouterError("Unauthorized", 401, "authentication")
    : { error: { message: "Unauthorized", type: "auth_error" } };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function tokensEqual(got: string, expected: string): boolean {
  const gotBuf = Buffer.from(got);
  const expectedBuf = Buffer.from(expected);
  if (gotBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(gotBuf, expectedBuf);
}

export function createApp(opts: ServerOptions): Hono {
  const app = new Hono();
  const { registry, verbose, token } = opts;
  const sessions = new SessionStore();
  const openRouterCatalog = new OpenRouterCatalog(registry, opts.openRouter);

  // No CORS: this gateway is for local SDK/script clients, not browser pages.
  // Wildcard CORS + loopback would let any tab on the machine read agent output.

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const got = m?.[1]?.trim();
    if (!got || !tokensEqual(got, token)) {
      return unauthorized(c.req.path.startsWith("/api/v1/"));
    }
    await next();
  });

  app.get("/", (c) =>
    c.json({
      name: "cli2api",
      version: "0.1.0",
      docs: "Local OpenAI-compatible gateway for coding CLIs",
      endpoints: ["/health", "/v1/models", "/v1/chat/completions", "/v1/responses", "/api/v1/models", "/api/v1/chat/completions", "/api/v1/responses"],
      default_adapter: registry.defaultAdapterId,
    }),
  );

  app.get("/health", async (c) => {
    const reports = await Promise.all(registry.list().map((a) => a.health()));
    const ok = reports.some((r) => r.ok);
    return c.json({ ok, adapters: reports }, ok ? 200 : 503);
  });

  app.get("/v1/models", async (c) => {
    return c.json({
      object: "list",
      data: await registry.listModels(),
    });
  });

  app.get("/api/v1/models", async (c) => {
    return c.json({
      data: await openRouterCatalog.list(new URL(c.req.url).searchParams),
    });
  });

  const chatCompletions: Handler = async (c) => {
    const openRouter = c.req.path.startsWith("/api/v1/");
    let body: ChatCompletionRequest;
    try {
      body = await c.req.json();
      if (openRouter && (!body.model || typeof body.model !== "string") && opts.openRouter?.defaultModel) {
        body = { ...body, model: opts.openRouter.defaultModel };
      }
    } catch {
      return c.json(openRouter
        ? openRouterError("Invalid JSON body", 400, "invalid_request")
        : { error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    let req;
    let requestedModel = "";
    try {
      req = normalizeChatRequest(body);
      requestedModel = req.model;
      if (openRouter && requestedModel.includes("/") && !registry.isExplicitlyRoutable(requestedModel)) {
        return c.json(openRouterError(
          `Model ${requestedModel} is visible in the OpenRouter catalog but has no local cli2api route.`,
          400,
          "invalid_request",
          { cli2api_code: "model_not_available" },
        ), 400);
      }
      req = registry.normalizeRequest(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status ?? 400;
      return c.json(openRouter
        ? openRouterError(message, status, "invalid_request")
        : { error: { message, type: "invalid_request_error" } }, status as 400);
    }

    let adapter;
    try {
      adapter = registry.resolve(req.model, opts.adapter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(openRouter
        ? openRouterError(message, 400, "invalid_request")
        : { error: { message, type: "invalid_request_error" } }, 400);
    }
    req = {
      ...req,
      nativeSessionId: sessions.get(req.sessionId, adapter.id),
    };

    if (verbose) {
      console.error(`[cli2api] ${adapter.id} model=${req.model} stream=${req.stream} msgs=${req.messages.length}`);
    }

    const id = completionId(openRouter ? "gen" : "chatcmpl");
    const includeReasoning = body.include_reasoning !== false
      && body.reasoning?.exclude !== true
      && body.reasoning?.enabled !== false;
    const includeUsage = openRouter || body.stream_options?.include_usage === true;
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        let toolIndex = 0;
        // Initial role chunk (OpenAI SDK expects this)
        await stream.writeSSE({
          data: JSON.stringify(
            buildChunk({ id, model: requestedModel, delta: { role: "assistant" }, openRouter }),
          ),
        });

        try {
          for await (const ev of transformToolEvents(adapter.chat(req, ac.signal), req)) {
            if (ev.type === "delta") {
              const channel = ev.channel ?? "content";
              if (channel === "reasoning") {
                if (!includeReasoning) continue;
                await stream.writeSSE({
                  data: JSON.stringify(
                    buildChunk({
                      id,
                      model: requestedModel,
                      delta: { reasoning: ev.text, reasoning_content: ev.text },
                      openRouter,
                    }),
                  ),
                });
              } else {
                await stream.writeSSE({
                  data: JSON.stringify(
                    buildChunk({ id, model: requestedModel, delta: { content: ev.text }, openRouter }),
                  ),
                });
              }
            } else if (ev.type === "tool_call") {
              await stream.writeSSE({
                data: JSON.stringify(
                  buildChunk({
                    id,
                    model: requestedModel,
                    delta: {
                      tool_calls: [{
                        index: toolIndex++,
                        id: ev.call.id,
                        type: "function",
                        function: ev.call.function,
                      }],
                    },
                    openRouter,
                  }),
                ),
              });
            } else if (ev.type === "session") {
              sessions.set(req.sessionId, adapter.id, ev.id);
            } else if (ev.type === "error") {
              await stream.writeSSE({
                data: JSON.stringify({
                  ...(openRouter
                    ? openRouterError(ev.message, 502, "provider_unavailable", { provider_code: ev.code })
                    : { error: { message: ev.message, type: "server_error", code: ev.code } }),
                }),
              });
              await stream.writeSSE({ data: "[DONE]" });
              return;
            } else if (ev.type === "done") {
              await stream.writeSSE({
                data: JSON.stringify(
                  buildChunk({ id, model: requestedModel, finishReason: ev.finishReason, openRouter }),
                ),
              });
              if (includeUsage && ev.usage) {
                const usage = await openRouterCatalog.withEstimatedCost(requestedModel, req.model, ev.usage);
                await stream.writeSSE({
                  data: JSON.stringify(buildChunk({
                    id,
                    model: requestedModel,
                    usage,
                    openRouter,
                    emptyChoices: true,
                  })),
                });
              }
            }
          }
          await stream.writeSSE({ data: "[DONE]" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await stream.writeSSE({
            data: JSON.stringify(openRouter
              ? openRouterError(message, 500, "server")
              : { error: { message, type: "server_error" } }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        }
      });
    }

    // Non-streaming
    try {
      const result = await collectChatText(transformToolEvents(adapter.chat(req, ac.signal), req));
      if (result.nativeSessionId) sessions.set(req.sessionId, adapter.id, result.nativeSessionId);
      if (result.error) {
        return c.json(openRouter
          ? openRouterError(result.error, 502, "provider_unavailable")
          : { error: { message: result.error, type: "server_error" } }, 502);
      }
      const response = buildCompletionResponse({
        id,
        model: requestedModel,
        content: result.text,
        finishReason: result.finishReason,
        usage: await openRouterCatalog.withEstimatedCost(requestedModel, req.model, result.usage),
        toolCalls: result.toolCalls,
        reasoning: includeReasoning ? result.reasoning : undefined,
        openRouter,
      });
      return c.json(req.sessionId ? { ...response, session_id: req.sessionId } : response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(openRouter
        ? openRouterError(message, 500, "server")
        : { error: { message, type: "server_error" } }, 500);
    }
  };

  app.post("/v1/chat/completions", chatCompletions);
  app.post("/api/v1/chat/completions", chatCompletions);

  const responses: Handler = async (c) => {
    const openRouter = c.req.path.startsWith("/api/v1/");
    let body: ResponsesRequest;
    try {
      body = await c.req.json();
      if (openRouter && (!body.model || typeof body.model !== "string") && opts.openRouter?.defaultModel) {
        body = { ...body, model: opts.openRouter.defaultModel };
      }
    } catch {
      return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    let req;
    let requestedModel = "";
    try {
      req = normalizeChatRequest(responsesToChat(body));
      requestedModel = req.model;
      if (openRouter && requestedModel.includes("/") && !registry.isExplicitlyRoutable(requestedModel)) {
        return c.json({ error: {
          message: `Model ${requestedModel} is visible in the OpenRouter catalog but has no local cli2api route.`,
          type: "invalid_request_error",
          code: "model_not_available",
        } }, 400);
      }
      req = registry.normalizeRequest(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: "invalid_request_error" } }, 400);
    }

    let adapter;
    try {
      adapter = registry.resolve(req.model, opts.adapter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: "invalid_request_error" } }, 400);
    }

    const id = responseId();
    const inheritedSession = sessions.get(body.previous_response_id, adapter.id);
    if (body.previous_response_id && !inheritedSession) {
      return c.json({
        error: {
          message: `Unknown, expired, or adapter-mismatched previous_response_id: ${body.previous_response_id}`,
          type: "invalid_request_error",
          param: "previous_response_id",
        },
      }, 400);
    }
    req = { ...req, nativeSessionId: inheritedSession };
    if (inheritedSession) sessions.set(id, adapter.id, inheritedSession);
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        let sequenceNumber = 0;
        const writeEvent = async (type: string, payload: Record<string, unknown>) => {
          await stream.writeSSE({
            event: type,
            data: JSON.stringify({ type, sequence_number: sequenceNumber++, ...payload }),
          });
        };
        const created = buildResponse({ id, model: requestedModel, status: "in_progress" });
        created.output = [];
        await writeEvent("response.created", { response: created });
        await writeEvent("response.in_progress", { response: created });
        let text = "";
        let reasoning = "";
        const calls = [] as import("../types.js").ToolCall[];
        const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const reasoningId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const outputItems: Array<Record<string, unknown>> = [];
        let usage: import("../types.js").ChatCompletionResponse["usage"];
        let nextOutputIndex = 0;
        let messageOutputIndex = -1;
        let reasoningOutputIndex = -1;
        let messageAdded = false;
        try {
          for await (const ev of transformToolEvents(adapter.chat(req, ac.signal), req)) {
            if (ev.type === "session") {
              sessions.set(id, adapter.id, ev.id);
            } else if (ev.type === "delta" && (ev.channel ?? "content") === "content") {
              if (!messageAdded) {
                messageAdded = true;
                messageOutputIndex = nextOutputIndex++;
                await writeEvent("response.output_item.added", { response_id: id, output_index: messageOutputIndex, item: { ...messageOutput(msgId, ""), status: "in_progress", content: [] } });
                await writeEvent("response.content_part.added", { response_id: id, item_id: msgId, output_index: messageOutputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              }
              text += ev.text;
              await writeEvent("response.output_text.delta", { response_id: id, item_id: msgId, output_index: messageOutputIndex, content_index: 0, delta: ev.text });
            } else if (ev.type === "delta") {
              if (reasoningOutputIndex < 0) {
                reasoningOutputIndex = nextOutputIndex++;
                await writeEvent("response.output_item.added", { response_id: id, output_index: reasoningOutputIndex, item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [] } });
                await writeEvent("response.reasoning_summary_part.added", { response_id: id, item_id: reasoningId, output_index: reasoningOutputIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
              }
              reasoning += ev.text;
              await writeEvent("response.reasoning_summary_text.delta", { response_id: id, item_id: reasoningId, output_index: reasoningOutputIndex, summary_index: 0, delta: ev.text });
            } else if (ev.type === "tool_call") {
              const outputIndex = nextOutputIndex++;
              calls.push(ev.call);
              const item = functionOutput(ev.call);
              outputItems[outputIndex] = item;
              await writeEvent("response.output_item.added", { response_id: id, output_index: outputIndex, item: { ...item, status: "in_progress", arguments: "" } });
              await writeEvent("response.function_call_arguments.delta", { response_id: id, item_id: item.id, output_index: outputIndex, delta: ev.call.function.arguments });
              await writeEvent("response.function_call_arguments.done", { response_id: id, item_id: item.id, output_index: outputIndex, arguments: ev.call.function.arguments });
              await writeEvent("response.output_item.done", { response_id: id, output_index: outputIndex, item });
            } else if (ev.type === "error") {
              const failed = buildResponse({ id, model: requestedModel, status: "failed", error: { message: ev.message, code: ev.code } });
              await writeEvent("response.failed", { response: failed });
              return;
            } else if (ev.type === "done") {
              usage = await openRouterCatalog.withEstimatedCost(requestedModel, req.model, ev.usage);
            }
          }
          if (reasoningOutputIndex >= 0) {
            const item = { id: reasoningId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: reasoning }] };
            outputItems[reasoningOutputIndex] = item;
            await writeEvent("response.reasoning_summary_text.done", { response_id: id, item_id: reasoningId, output_index: reasoningOutputIndex, summary_index: 0, text: reasoning });
            await writeEvent("response.reasoning_summary_part.done", { response_id: id, item_id: reasoningId, output_index: reasoningOutputIndex, summary_index: 0, part: { type: "summary_text", text: reasoning } });
            await writeEvent("response.output_item.done", { response_id: id, output_index: reasoningOutputIndex, item });
          }
          if (!calls.length) {
            if (!messageAdded) {
              messageOutputIndex = nextOutputIndex++;
              await writeEvent("response.output_item.added", { response_id: id, output_index: messageOutputIndex, item: { ...messageOutput(msgId, ""), status: "in_progress", content: [] } });
              await writeEvent("response.content_part.added", { response_id: id, item_id: msgId, output_index: messageOutputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            }
            const item = messageOutput(msgId, text);
            outputItems[messageOutputIndex] = item;
            await writeEvent("response.output_text.done", { response_id: id, item_id: msgId, output_index: messageOutputIndex, content_index: 0, text });
            await writeEvent("response.content_part.done", { response_id: id, item_id: msgId, output_index: messageOutputIndex, content_index: 0, part: { type: "output_text", text, annotations: [] } });
            await writeEvent("response.output_item.done", { response_id: id, output_index: messageOutputIndex, item });
          }
          const response = buildResponse({ id, model: requestedModel, text, reasoning, toolCalls: calls, usage });
          response.output = outputItems;
          await writeEvent("response.completed", { response });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await writeEvent("error", { message });
        }
      });
    }

    try {
      const result = await collectChatText(transformToolEvents(adapter.chat(req, ac.signal), req));
      if (result.nativeSessionId) sessions.set(id, adapter.id, result.nativeSessionId);
      if (result.error) return c.json({ error: { message: result.error, type: "server_error" } }, 502);
      const usage = await openRouterCatalog.withEstimatedCost(requestedModel, req.model, result.usage);
      return c.json(buildResponse({ id, model: requestedModel, text: result.text, reasoning: result.reasoning, toolCalls: result.toolCalls, usage }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: "server_error" } }, 500);
    }
  };

  app.post("/v1/responses", responses);
  app.post("/api/v1/responses", responses);

  // Friendly 404 for unknown routes
  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `Unknown route ${c.req.method} ${c.req.path}. Try /v1/chat/completions, /api/v1/chat/completions, /v1/responses, or /v1/models.`,
          type: "invalid_request_error",
        },
      },
      404,
    ),
  );

  return app;
}

/** Kept for callers that want raw SSE strings without Hono stream helper. */
export { sseLine };
