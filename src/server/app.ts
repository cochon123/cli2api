import { timingSafeEqual } from "node:crypto";
import { Hono, type Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import type { AdapterRegistry } from "../adapters/registry.js";
import { collectChatText, limitChatEvents } from "../adapters/types.js";
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
import { AdapterLimiter, QueueFullError } from "./limiter.js";
import {
  anthropicError,
  anthropicMessageId,
  anthropicStopReason,
  anthropicToChat,
  anthropicUsage,
  buildAnthropicMessage,
  type AnthropicMessagesRequest,
} from "../protocol/anthropic.js";
import { VERSION } from "../version.js";

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
  /** Maximum live subprocesses per adapter. */
  maxConcurrency?: number;
  /** Maximum requests waiting for each adapter. */
  maxQueue?: number;
  /** Maximum HTTP request body size. */
  maxBodyBytes?: number;
  /** Request controllers owned by the listener for graceful shutdown. */
  activeRequests?: Set<AbortController>;
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

function unauthorized(openRouter = false, anthropic = false) {
  const body = anthropic
    ? anthropicError("Invalid API key", "authentication_error")
    : openRouter
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

function chatSessionKey(adapter: string, id: string | undefined): string | undefined {
  return id ? `chat:${adapter}:${id}` : undefined;
}

function responseSessionKey(id: string | undefined): string | undefined {
  return id ? `responses:${id}` : undefined;
}

export function createApp(opts: ServerOptions): Hono {
  const app = new Hono();
  const { registry, verbose, token } = opts;
  const sessions = new SessionStore();
  const openRouterCatalog = new OpenRouterCatalog(registry, opts.openRouter);
  const limiter = new AdapterLimiter(opts.maxConcurrency ?? 2, opts.maxQueue ?? 16);
  const sessionLimiter = new AdapterLimiter(1, opts.maxQueue ?? 16, true);
  const maxBodyBytes = opts.maxBodyBytes ?? 2 * 1_048_576;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 100 * 1_048_576) {
    throw new Error("maxBodyBytes must be an integer between 1024 and 104857600");
  }

  // No CORS: this gateway is for local SDK/script clients, not browser pages.
  // Wildcard CORS + loopback would let any tab on the machine read agent output.

  app.use("*", async (c, next) => {
    const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("request-id", requestId);
    c.header("x-request-id", requestId);
  });

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const candidates = [m?.[1]?.trim(), c.req.header("x-api-key")?.trim()]
      .filter((value): value is string => Boolean(value));
    if (!candidates.some((candidate) => tokensEqual(candidate, token))) {
      return unauthorized(c.req.path.startsWith("/api/v1/"), c.req.path.endsWith("/messages"));
    }
    await next();
  });

  app.use("*", bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.req.path.endsWith("/messages")
      ? c.json(anthropicError(`Request body exceeds the ${maxBodyBytes}-byte limit`, "request_too_large"), 413)
      : c.json({
        error: {
          message: `Request body exceeds the ${maxBodyBytes}-byte limit`,
          type: "invalid_request_error",
          code: "request_too_large",
        },
      }, 413),
  }));

  app.get("/", (c) =>
    c.json({
      name: "cli2api",
      version: VERSION,
      docs: "Local OpenAI-compatible gateway for coding CLIs",
      endpoints: ["/health", "/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages", "/api/v1/models", "/api/v1/chat/completions", "/api/v1/responses", "/api/v1/messages"],
      default_adapter: registry.defaultAdapterId,
      limits: { max_concurrency_per_adapter: limiter.maxConcurrent, max_queue_per_adapter: limiter.maxQueue, max_body_bytes: maxBodyBytes },
    }),
  );

  app.get("/health", async (c) => {
    const selectedAdapter = registry.get(registry.defaultAdapterId);
    if (!selectedAdapter) {
      return c.json({ ok: false, selected_adapter: registry.defaultAdapterId, message: "selected adapter is not registered", capacity: limiter.snapshot() }, 503);
    }
    const [capability, runtime] = await Promise.all([
      registry.capabilityReport(selectedAdapter),
      registry.runtimeHealth(selectedAdapter),
    ]);
    const ok = capability.ok && runtime.ok;
    return c.json({ ok, selected_adapter: registry.defaultAdapterId, capability, runtime, capacity: limiter.snapshot() }, ok ? 200 : 503);
  });

  app.get("/v1/models", async (c) => {
    return c.json({
      object: "list",
      data: await registry.listRunnableModels(),
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
    const id = completionId(openRouter ? "gen" : "chatcmpl");
    const includeReasoning = body.include_reasoning !== false
      && body.reasoning?.exclude !== true
      && body.reasoning?.enabled !== false;
    const ac = new AbortController();
    opts.activeRequests?.add(ac);
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
    let releaseSession = () => {};
    if (req.sessionId) {
      try {
        releaseSession = await sessionLimiter.acquire(`${adapter.id}:${req.sessionId}`, ac.signal);
      } catch (err) {
        const status = err instanceof QueueFullError ? 429 : 499;
        const message = err instanceof Error ? err.message : String(err);
        opts.activeRequests?.delete(ac);
        return c.json(openRouter
          ? openRouterError(message, status, status === 429 ? "rate_limit" : "request_cancelled", { cli2api_code: (err as { code?: string }).code })
          : { error: { message, type: status === 429 ? "rate_limit_error" : "request_cancelled", code: (err as { code?: string }).code } }, status as 429);
      }
    }
    // Lookup only after acquiring the session lock; queued turns then see the
    // native id emitted by the preceding request.
    const storedChatSessionKey = chatSessionKey(adapter.id, req.sessionId);
    req = { ...req, nativeSessionId: sessions.get(storedChatSessionKey, adapter.id) };
    if (verbose) {
      console.error(`[cli2api] ${adapter.id} model=${req.model} stream=${req.stream} msgs=${req.messages.length}`);
    }
    let releaseCapacity: () => void;
    try {
      releaseCapacity = await limiter.acquire(adapter.id, ac.signal);
    } catch (err) {
      const status = err instanceof QueueFullError ? 429 : 499;
      const message = err instanceof Error ? err.message : String(err);
      releaseSession();
      opts.activeRequests?.delete(ac);
      return c.json(openRouter
        ? openRouterError(message, status, status === 429 ? "rate_limit" : "request_cancelled", { cli2api_code: (err as { code?: string }).code })
        : { error: { message, type: status === 429 ? "rate_limit_error" : "request_cancelled", code: (err as { code?: string }).code } }, status as 429);
    }
    const adapterEvents = limitChatEvents(adapter.chat(req, ac.signal));

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        try {
          let toolIndex = 0;
          // Initial role chunk (OpenAI SDK expects this)
          await stream.writeSSE({
            data: JSON.stringify(
              buildChunk({ id, model: requestedModel, delta: { role: "assistant" }, openRouter }),
            ),
          });
          try {
            for await (const ev of transformToolEvents(adapterEvents, req)) {
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
              sessions.set(storedChatSessionKey, adapter.id, ev.id);
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
              if (openRouter && ev.usage) {
                await stream.writeSSE({
                  data: JSON.stringify(buildChunk({
                    id,
                    model: requestedModel,
                    usage: ev.usage,
                    openRouter: true,
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
        } finally {
          releaseCapacity();
          releaseSession();
          opts.activeRequests?.delete(ac);
        }
      });
    }

    // Non-streaming
    try {
      const result = await collectChatText(transformToolEvents(adapterEvents, req));
      if (result.nativeSessionId) sessions.set(storedChatSessionKey, adapter.id, result.nativeSessionId);
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
        usage: result.usage,
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
    } finally {
      releaseCapacity();
      releaseSession();
      opts.activeRequests?.delete(ac);
    }
  };

  app.post("/v1/chat/completions", chatCompletions);
  app.post("/api/v1/chat/completions", chatCompletions);

  const messages: Handler = async (c) => {
    let body: AnthropicMessagesRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json(anthropicError("Invalid JSON body", "invalid_request_error"), 400);
    }

    let req;
    let requestedModel = "";
    try {
      req = normalizeChatRequest(anthropicToChat(body));
      requestedModel = req.model;
      if (c.req.path.startsWith("/api/v1/") && requestedModel.includes("/") && !registry.isExplicitlyRoutable(requestedModel)) {
        return c.json(anthropicError(
          `Model ${requestedModel} has no local cli2api route.`,
          "not_found_error",
        ), 404);
      }
      req = registry.normalizeRequest(req);
    } catch (error) {
      return c.json(anthropicError(
        error instanceof Error ? error.message : String(error),
        "invalid_request_error",
      ), ((error as { status?: number }).status ?? 400) as 400);
    }

    let adapter;
    try {
      adapter = registry.resolve(req.model, opts.adapter);
    } catch (error) {
      return c.json(anthropicError(
        error instanceof Error ? error.message : String(error),
        "not_found_error",
      ), 404);
    }

    const id = anthropicMessageId();
    const ac = new AbortController();
    opts.activeRequests?.add(ac);
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
    let releaseCapacity: () => void;
    try {
      releaseCapacity = await limiter.acquire(adapter.id, ac.signal);
    } catch (error) {
      const status = error instanceof QueueFullError ? 429 : 499;
      opts.activeRequests?.delete(ac);
      return c.json(anthropicError(
        error instanceof Error ? error.message : String(error),
        status === 429 ? "rate_limit_error" : "request_cancelled_error",
      ), status as 429);
    }
    const adapterEvents = limitChatEvents(adapter.chat(req, ac.signal));

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        let blockIndex = -1;
        let openBlock: "thinking" | "text" | "tool" | null = null;
        let usage: import("../types.js").ChatCompletionResponse["usage"];
        let finishReason: "stop" | "length" | "tool_calls" | "error" = "stop";
        let failed = false;

        const write = async (type: string, payload: Record<string, unknown>) => {
          await stream.writeSSE({ event: type, data: JSON.stringify({ type, ...payload }) });
        };
        const closeBlock = async () => {
          if (!openBlock) return;
          if (openBlock === "thinking") {
            await write("content_block_delta", {
              index: blockIndex,
              delta: { type: "signature_delta", signature: "cli2api" },
            });
          }
          await write("content_block_stop", { index: blockIndex });
          openBlock = null;
        };
        const startBlock = async (kind: "thinking" | "text", block: Record<string, unknown>) => {
          if (openBlock !== kind) {
            await closeBlock();
            blockIndex += 1;
            openBlock = kind;
            await write("content_block_start", { index: blockIndex, content_block: block });
          }
        };

        try {
          await write("message_start", {
            message: {
              id,
              type: "message",
              role: "assistant",
              model: requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
            },
          });

          try {
            for await (const event of transformToolEvents(adapterEvents, req)) {
              if (event.type === "delta") {
                if ((event.channel ?? "content") === "reasoning") {
                  if (body.thinking?.type !== "enabled") continue;
                  await startBlock("thinking", { type: "thinking", thinking: "", signature: "" });
                  await write("content_block_delta", { index: blockIndex, delta: { type: "thinking_delta", thinking: event.text } });
                } else {
                  await startBlock("text", { type: "text", text: "" });
                  await write("content_block_delta", { index: blockIndex, delta: { type: "text_delta", text: event.text } });
                }
              } else if (event.type === "tool_call") {
                await closeBlock();
                blockIndex += 1;
                openBlock = "tool";
                await write("content_block_start", {
                  index: blockIndex,
                  content_block: { type: "tool_use", id: event.call.id, name: event.call.function.name, input: {} },
                });
                await write("content_block_delta", {
                  index: blockIndex,
                  delta: { type: "input_json_delta", partial_json: event.call.function.arguments },
                });
                await closeBlock();
              } else if (event.type === "done") {
                finishReason = event.finishReason;
                usage = event.usage;
              } else if (event.type === "error") {
                failed = true;
                await write("error", { error: { type: "api_error", message: event.message } });
                return;
              }
            }
            await closeBlock();
            if (!failed) {
              await write("message_delta", {
                delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
                usage: { output_tokens: anthropicUsage(usage).output_tokens },
              });
              await write("message_stop", {});
            }
          } catch (error) {
            await write("error", { error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
          }
        } finally {
          releaseCapacity();
          opts.activeRequests?.delete(ac);
        }
      });
    }

    try {
      const result = await collectChatText(transformToolEvents(adapterEvents, req));
      if (result.error) return c.json(anthropicError(result.error, "api_error"), 502);
      return c.json(buildAnthropicMessage({
        id,
        model: requestedModel,
        text: result.text,
        reasoning: body.thinking?.type === "enabled" ? result.reasoning : undefined,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        usage: result.usage,
      }));
    } catch (error) {
      return c.json(anthropicError(error instanceof Error ? error.message : String(error), "api_error"), 500);
    } finally {
      releaseCapacity();
      opts.activeRequests?.delete(ac);
    }
  };

  app.post("/v1/messages", messages);
  app.post("/api/v1/messages", messages);

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
    // Keep an in-flight native session under a private reservation. The public
    // response id becomes resumable only after the response completes, so a
    // client cannot branch a transcript by continuing a still-running stream.
    const previousSessionKey = responseSessionKey(body.previous_response_id);
    const publicSessionKey = responseSessionKey(id)!;
    const reservationId = `responses:pending:${id}`;
    const inheritedSession = sessions.move(previousSessionKey, reservationId, adapter.id);
    if (body.previous_response_id && !inheritedSession) {
      return c.json({
        error: {
          message: `Unknown, expired, or adapter-mismatched previous_response_id: ${body.previous_response_id}`,
          type: "invalid_request_error",
          param: "previous_response_id",
        },
      }, 400);
    }
    // Mark every Responses request as session-capable. This keeps the initial
    // native transcript only when the returned response id can actually resume it.
    req = { ...req, nativeSessionId: inheritedSession, sessionId: id };
    let sessionCommitted = false;
    const commitSession = () => {
      sessionCommitted = Boolean(sessions.move(reservationId, publicSessionKey, adapter.id));
    };
    const rollbackSession = () => {
      if (body.previous_response_id && inheritedSession) {
        sessions.move(sessionCommitted ? publicSessionKey : reservationId, previousSessionKey, adapter.id);
      } else {
        sessions.delete(reservationId);
        sessions.delete(publicSessionKey);
      }
      sessionCommitted = false;
    };
    const ac = new AbortController();
    opts.activeRequests?.add(ac);
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
    let releaseCapacity: () => void;
    try {
      releaseCapacity = await limiter.acquire(adapter.id, ac.signal);
    } catch (err) {
      const status = err instanceof QueueFullError ? 429 : 499;
      const message = err instanceof Error ? err.message : String(err);
      rollbackSession();
      opts.activeRequests?.delete(ac);
      return c.json({ error: { message, type: status === 429 ? "rate_limit_error" : "request_cancelled", code: (err as { code?: string }).code } }, status as 429);
    }
    const adapterEvents = limitChatEvents(adapter.chat(req, ac.signal));

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        try {
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
            for await (const ev of transformToolEvents(adapterEvents, req)) {
            if (ev.type === "session") {
              sessions.set(reservationId, adapter.id, ev.id);
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
              rollbackSession();
              const failed = buildResponse({ id, model: requestedModel, status: "failed", error: { message: ev.message, code: ev.code } });
              await writeEvent("response.failed", { response: failed });
              return;
            } else if (ev.type === "done") {
              usage = ev.usage;
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
            commitSession();
            await writeEvent("response.completed", { response });
          } catch (err) {
            rollbackSession();
            const message = err instanceof Error ? err.message : String(err);
            await writeEvent("error", { message });
          }
        } catch {
          // A disconnect or failed write can happen outside the inner event
          // loop. Restore the consumed previous_response_id so the caller can
          // safely retry instead of losing its resumable session.
          rollbackSession();
        } finally {
          releaseCapacity();
          opts.activeRequests?.delete(ac);
        }
      });
    }

    try {
      const result = await collectChatText(transformToolEvents(adapterEvents, req));
      if (result.nativeSessionId) sessions.set(reservationId, adapter.id, result.nativeSessionId);
      if (result.error) {
        rollbackSession();
        return c.json({ error: { message: result.error, type: "server_error" } }, 502);
      }
      commitSession();
      return c.json(buildResponse({ id, model: requestedModel, text: result.text, reasoning: result.reasoning, toolCalls: result.toolCalls, usage: result.usage }));
    } catch (err) {
      rollbackSession();
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: "server_error" } }, 500);
    } finally {
      releaseCapacity();
      opts.activeRequests?.delete(ac);
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
