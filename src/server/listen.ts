import { serve } from "@hono/node-server";
import type { AdapterRegistry } from "../adapters/registry.js";
import { createApp, type OpenRouterServerOptions } from "./app.js";

export interface ListenOptions {
  registry: AdapterRegistry;
  host?: string;
  port?: number;
  adapter?: string;
  /** Required bearer token (generate one at startup if the operator did not set it). */
  token: string;
  verbose?: boolean;
  openRouter?: OpenRouterServerOptions;
  maxConcurrency?: number;
  maxQueue?: number;
  maxBodyBytes?: number;
}

export function assertLoopbackHost(host: string): void {
  const allowed = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!allowed.has(host)) {
    throw new Error(
      `Refusing to bind to "${host}". cli2api is local-only; use 127.0.0.1 (default). ` +
        `If you really need another interface, this is the wrong tool — do not expose CLI auth.`,
    );
  }
}

/** Build a valid HTTP origin for IPv4, localhost, or the IPv6 loopback. */
export function loopbackOrigin(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export async function listen(opts: ListenOptions): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3927;
  assertLoopbackHost(host);

  const activeRequests = new Set<AbortController>();
  const app = createApp({
    registry: opts.registry,
    adapter: opts.adapter,
    token: opts.token,
    verbose: opts.verbose,
    openRouter: opts.openRouter,
    maxConcurrency: opts.maxConcurrency,
    maxQueue: opts.maxQueue,
    maxBodyBytes: opts.maxBodyBytes,
    activeRequests,
  });

  const server = serve({ fetch: app.fetch, hostname: host, port });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    host,
    port: actualPort,
    close: async () => {
      for (const controller of activeRequests) controller.abort();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          finish();
        }, 3_000);
        timer.unref();
        server.close(finish);
      });
    },
  };
}
