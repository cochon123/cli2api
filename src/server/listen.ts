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

export async function listen(opts: ListenOptions): Promise<{ host: string; port: number; close: () => void }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3927;
  assertLoopbackHost(host);

  const app = createApp({
    registry: opts.registry,
    adapter: opts.adapter,
    token: opts.token,
    verbose: opts.verbose,
    openRouter: opts.openRouter,
  });

  const server = serve({ fetch: app.fetch, hostname: host, port });

  return {
    host,
    port,
    close: () => {
      server.close();
    },
  };
}
