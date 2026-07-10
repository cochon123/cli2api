import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AdapterRegistry } from "../adapters/registry.js";
import { collectChatText } from "../adapters/types.js";
import type { ChatCompletionRequest } from "../types.js";
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
}

function unauthorized() {
  return new Response(JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }), {
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

  // No CORS: this gateway is for local SDK/script clients, not browser pages.
  // Wildcard CORS + loopback would let any tab on the machine read agent output.

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const got = m?.[1]?.trim();
    if (!got || !tokensEqual(got, token)) {
      return unauthorized();
    }
    await next();
  });

  app.get("/", (c) =>
    c.json({
      name: "cli2api",
      version: "0.1.0",
      docs: "Local OpenAI-compatible gateway for coding CLIs",
      endpoints: ["/health", "/v1/models", "/v1/chat/completions"],
      default_adapter: registry.defaultAdapterId,
    }),
  );

  app.get("/health", async (c) => {
    const reports = await Promise.all(registry.list().map((a) => a.health()));
    const ok = reports.some((r) => r.ok);
    return c.json({ ok, adapters: reports }, ok ? 200 : 503);
  });

  app.get("/v1/models", async (c) => {
    const all = await Promise.all(registry.list().map((a) => a.listModels()));
    return c.json({
      object: "list",
      data: all.flat(),
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    let body: ChatCompletionRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    let req;
    try {
      req = normalizeChatRequest(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status ?? 400;
      return c.json({ error: { message, type: "invalid_request_error" } }, status as 400);
    }

    let adapter;
    try {
      adapter = registry.resolve(req.model, opts.adapter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: "invalid_request_error" } }, 400);
    }

    if (verbose) {
      console.error(`[cli2api] ${adapter.id} model=${req.model} stream=${req.stream} msgs=${req.messages.length}`);
    }

    const id = completionId();
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        // Initial role chunk (OpenAI SDK expects this)
        await stream.writeSSE({
          data: JSON.stringify(
            buildChunk({ id, model: req.model, delta: { role: "assistant" } }),
          ),
        });

        try {
          for await (const ev of adapter.chat(req, ac.signal)) {
            if (ev.type === "delta") {
              const channel = ev.channel ?? "content";
              if (channel === "reasoning") {
                await stream.writeSSE({
                  data: JSON.stringify(
                    buildChunk({
                      id,
                      model: req.model,
                      delta: { reasoning: ev.text, reasoning_content: ev.text },
                    }),
                  ),
                });
              } else {
                await stream.writeSSE({
                  data: JSON.stringify(
                    buildChunk({ id, model: req.model, delta: { content: ev.text } }),
                  ),
                });
              }
            } else if (ev.type === "error") {
              await stream.writeSSE({
                data: JSON.stringify({
                  error: { message: ev.message, type: "server_error", code: ev.code },
                }),
              });
              await stream.writeSSE({ data: "[DONE]" });
              return;
            } else if (ev.type === "done") {
              await stream.writeSSE({
                data: JSON.stringify(
                  buildChunk({ id, model: req.model, finishReason: ev.finishReason }),
                ),
              });
            }
          }
          await stream.writeSSE({ data: "[DONE]" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await stream.writeSSE({
            data: JSON.stringify({ error: { message, type: "server_error" } }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        }
      });
    }

    // Non-streaming
    try {
      const result = await collectChatText(adapter.chat(req, ac.signal));
      if (result.error) {
        return c.json(
          { error: { message: result.error, type: "server_error" } },
          502,
        );
      }
      return c.json(
        buildCompletionResponse({
          id,
          model: req.model,
          content: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: "server_error" } }, 500);
    }
  });

  // Friendly 404 for unknown routes
  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `Unknown route ${c.req.method} ${c.req.path}. Try /v1/chat/completions or /v1/models.`,
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
