# cli2api

One small, local gateway for seven coding CLIs. Give an OpenAI, Anthropic, or OpenRouter client a localhost URL and use the login you already have in Codex, OpenCode, Cursor Agent, Claude Code, Gemini CLI, Qwen Code, or GitHub Copilot CLI.

cli2api is built for two users at once:

- **Humans:** `cli2api run -- your-command` starts an authenticated gateway, injects the right environment variables, runs the command, and cleans up.
- **Agents and automation:** ephemeral ports, one-line readiness JSON, JSON diagnostics, predictable model prefixes, structured errors, request IDs, and graceful shutdown make orchestration mechanical.
- **Security-conscious local use:** loopback-only, authenticated by default, no CORS, a fresh empty cwd by default, restrictive CLI modes, scrubbed child environments, and bounded requests, queues, processes, and output.
- **Broad compatibility without a large daemon:** seven real CLI adapters, three request schemas, OpenRouter aliases, zero separately installed runtime npm dependencies, and a measured **118 kB tarball / 0.38 MiB installed tree**.

> cli2api is a single-user localhost bridge, not a multi-tenant service. It intentionally refuses non-loopback binds. Do not publish its port through a reverse proxy or tunnel.

## Fastest start: wrap the client

Install the published package:

```bash
npm install --global @cochon123/cli2api
cli2api doctor
```

To install the latest repository revision instead, use `npm install --global github:cochon123/cli2api`. Git installs run the package's build lifecycle, so do not combine a source install with `--ignore-scripts`; registry tarballs already contain the built bundle.

The package name is `@cochon123/cli2api` because the unscoped npm name belongs to another publisher; the executable is still `cli2api`.

If your program already reads OpenAI, OpenRouter, or Anthropic environment variables, no token copying or fixed port is needed:

```bash
cli2api run --adapter auto -- node my-agent.mjs
```

`auto` finds an installed CLI that passes its structured/safety contract (and an authentication check where the CLI exposes one), then falls back to the deterministic mock adapter. Authentication can still expire between the check and a request. The wrapper starts on an ephemeral port, generates a token, and injects all of these into the child process:

```text
OPENAI_BASE_URL       OPENAI_API_BASE      OPENAI_API_KEY       OPENAI_MODEL
OPENROUTER_BASE_URL   OPENROUTER_API_KEY
ANTHROPIC_BASE_URL    ANTHROPIC_API_KEY    ANTHROPIC_AUTH_TOKEN    ANTHROPIC_MODEL
CLI2API_BASE_URL      CLI2API_TOKEN         CLI2API_MODEL
```

Pin the backend or model when reproducibility matters:

```bash
cli2api run --adapter codex --model codex/gpt-5.5 -- python3 benchmark.py
```

Arguments after `--` belong to the child, including its own `--config` flag. cli2api returns the child's exit status and closes the gateway even when the child fails.

## Persistent server

For several clients, start one server. cli2api uses a fresh empty temporary directory unless you explicitly grant project access:

```bash
export CLI2API_TOKEN="$(openssl rand -hex 32)"
cli2api serve --adapter codex --port 3927
```

Then point a client at it:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3927/v1
export OPENAI_API_KEY="$CLI2API_TOKEN"
export OPENAI_MODEL=codex/default

curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"codex/default","messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
```

Use `--project` to make the current directory visible to the CLI, or `--cwd /absolute/path` to expose a specific directory:

```bash
cli2api serve --adapter codex --project
cli2api run --adapter codex --cwd /work/repo -- node my-agent.mjs
```

These flags make the directory visible to the subprocess; each adapter's restrictive tool policy still governs whether it can read anything. They also opt into any project instructions the selected CLI normally discovers. Cursor additionally receives its required headless `--trust` acknowledgement. Prompts do not need repository access for ordinary chat, evaluation, or API compatibility tests, so the empty cwd is the safer default.

The empty working directory limits automatically discovered project context. It is not an operating-system filesystem sandbox: the CLI process still runs as your user and can access its own login/configuration locations. The adapter's sandbox/policy is the enforcement layer.

### Machine-readable startup

An orchestrator can ask the OS for a free port and parse exactly one readiness object from stdout:

```bash
cli2api serve --adapter auto --port 0 --json
```

```json
{"ready":true,"pid":12345,"base_url":"http://127.0.0.1:43127","openai_base_url":"http://127.0.0.1:43127/v1","openrouter_base_url":"http://127.0.0.1:43127/api/v1","anthropic_base_url":"http://127.0.0.1:43127","token":"…","adapter":"codex","adapter_ready":true,"model":"codex/default","workspace":"/tmp/cli2api-workspace-…","isolated_workspace":true}
```

Logs stay on stderr. For most agent runners, `cli2api run` is simpler because the token never needs to be parsed or persisted.

## Supported CLIs

The mock adapter is included for deterministic integration tests but is not counted in the seven CLI backends.

| Prefix | CLI invocation | Restrictive default | Streaming/session behavior |
|---|---|---|---|
| `codex/` | `codex exec --json` | read-only sandbox; stateless calls are ephemeral | native JSONL; native resume |
| `opencode/` | `opencode run --format json` | cli2api-owned deny-by-default agent/config; `--pure` disables external plugins | completed JSON events; native resume |
| `cursor/` | `cursor-agent` stream JSON | vendor read-only Ask mode; sandbox requested; workspace trust auto-acknowledged | native partial events; native resume |
| `claude/` | Claude Code headless stream JSON | safe mode; settings/tools/MCP disabled; stateless calls disable persistence | native partial events; native resume |
| `gemini/` | Gemini CLI stream JSON | plan approval plus cli2api admin deny policy; extensions, hooks, MCP, and skills disabled | native JSONL; native resume |
| `qwen/` | Qwen Code stream JSON | safe + plan modes; shell/write/edit/agent excluded; zero tool calls | native partial events; native resume |
| `copilot/` | GitHub Copilot CLI programmatic prompt | plan mode; read-only tool allowlist; remote/MCP/custom instructions disabled | buffered output; explicit sessions |

Any model accepted by a CLI can be addressed as `prefix/model`, for example `codex/gpt-5.5`, `claude/sonnet`, or `opencode/openrouter/deepseek/deepseek-v4-flash`. Use `prefix/default` to let that CLI choose its default.

Check compatibility rather than guessing:

```bash
cli2api doctor                 # inventory; optional missing CLIs are shown as skips
cli2api doctor --adapter qwen  # strict check for one adapter
cli2api doctor --all --json    # strict, machine-readable full inventory
cli2api adapters --json        # registered adapter inventory
cli2api models --json          # configured model catalog
```

The adapters follow the CLIs' documented headless contracts and have parser/argument fixtures in the test suite. Availability, flags, authentication, and model names can still vary by installed CLI version; `doctor --adapter …` is the authoritative compatibility preflight on a machine, but help/version checks do not prove that an OS sandbox is active.

## API compatibility

Every route requires either `Authorization: Bearer <token>` or `x-api-key: <token>`.

| Client surface | Base URL | Routes |
|---|---|---|
| OpenAI | `http://127.0.0.1:3927/v1` | `GET /models`, `POST /chat/completions`, `POST /responses` |
| Anthropic | `http://127.0.0.1:3927` | `POST /v1/messages` |
| OpenRouter | `http://127.0.0.1:3927/api/v1` | `GET /models`, `POST /chat/completions`, `POST /responses`, `POST /messages` |

Implemented behavior includes non-streaming and SSE, reasoning/thinking blocks, usage, function tools, OpenAI `previous_response_id`, Anthropic tool blocks, and client-selected Chat Completions `session_id`. This is a focused compatibility layer, not a promise that every vendor-specific field has an equivalent in every CLI.

Function schemas are supplied to CLIs in a constrained prompt envelope because the seven tools do not expose one uniform native function protocol. cli2api validates the returned tool name and JSON arguments; `strict: true` arguments are checked against the supplied JSON Schema.

Sessions are adapter-bound, protocol-namespaced, and in memory. The store holds at most 1,000 mappings for 24 hours; restarts invalidate them. Chat requests sharing an explicit `session_id` are serialized. A Responses ID is atomically consumed and moved forward, so concurrent reuse fails instead of forking stale native state.

### OpenRouter catalog and aliases

The default `runnable` catalog lists only adapters that pass a cached capability check. Public OpenRouter model IDs can be mapped to local CLI models:

```json
{
  "modelAliases": {
    "fast": "opencode/deepseek-v4-flash-free"
  },
  "openRouter": {
    "defaultModel": "openai/gpt-local",
    "catalogMode": "runnable",
    "modelRoutes": {
      "openai/gpt-local": { "adapter": "codex", "model": "default" },
      "anthropic/claude-sonnet-4": { "adapter": "claude", "model": "sonnet" }
    }
  }
}
```

`mirror` mode exposes cached OpenRouter metadata for discovery, but a visible cloud model still needs a local route before it can run. Metadata is cached for 24 hours under `$XDG_CACHE_HOME/cli2api`; an `OPENROUTER_API_KEY` is sent only to the canonical `https://openrouter.ai` origin, never to a configured custom metadata URL. Hosted pricing metadata does not describe local CLI execution.

## Why choose cli2api?

The closest projects optimize for different jobs. CLIProxyAPI is a large direct OAuth gateway, ChatMock focuses on one ChatGPT account, and several smaller projects trade away authentication or protocol breadth. For the specific job **"put several installed coding CLIs behind a safe local API"**, cli2api has the strongest breadth/weight/default-safety combination in this snapshot.

### Quantitative comparison

Snapshot: **2026-07-11**. Stars are popularity context, not a quality score.

| Project | Stars | Active backend breadth | Client API surface | Packaged/runtime footprint | Local security default |
|---|---:|---|---|---:|---|
| **cli2api** | 1 | **7 subprocess CLIs** | **8 client routes; Chat + Responses + Messages + OpenRouter aliases** | **118 kB tarball; 0.38 MiB installed; 0 separately installed runtime npm deps** | **loopback-only, required token, no CORS, fresh empty cwd** |
| [star-cliproxy](https://github.com/starhunt/star-cliproxy) | 23 | 5 subprocess CLIs | 9 route shapes | 210.50 MiB installed | loopback and auth by default |
| [agent-cli-to-api](https://github.com/leeguooooo/agent-cli-to-api) | 63 | 4 hybrid backends | 10 method/path pairs, including Messages | 40.45 MiB virtualenv | loopback; authentication optional/unset by default |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | ~39.9k | direct OAuth gateway: 5 login providers / 7 provider channels | broadest protocol set in this group | 14.13 MiB archive; 43.35 MiB extracted | API-key middleware; binds all interfaces by default |
| [ChatMock](https://github.com/RayBytes/ChatMock) | ~1.5k | 1 direct ChatGPT OAuth backend | 8 HTTP routes + Responses WebSocket | 63.2 kB wheel; 4.77 MiB virtualenv | loopback, but no inbound auth and reflective CORS |
| [llm-cli-proxy](https://github.com/slopedrop/llm-cli-proxy) | 2 | 3 hybrid backends | 2 routes: Chat + models | 29.4 kB npm tarball; 2.51 MiB production tree | no inbound auth; wildcard CORS; interface unspecified |

The result is deliberately not "cli2api wins every cell": CLIProxyAPI has the broadest provider/protocol gateway, and the single-purpose projects can be smaller. cli2api's lead is the combination of the most subprocess CLI backends, all three modern request schemas, a small install, and secure defaults.

Source anchors for backend/API/security claims: [star-cliproxy coverage](https://github.com/starhunt/star-cliproxy/blob/91b7167f898b824f4793ee1ecc771de8c780b457/README.md#L9-L34), [route registration](https://github.com/starhunt/star-cliproxy/blob/91b7167f898b824f4793ee1ecc771de8c780b457/packages/server/src/app.ts#L11-L17), [Responses route](https://github.com/starhunt/star-cliproxy/blob/91b7167f898b824f4793ee1ecc771de8c780b457/packages/server/src/app.ts#L192-L195), [model routes](https://github.com/starhunt/star-cliproxy/blob/91b7167f898b824f4793ee1ecc771de8c780b457/packages/server/src/routes/v1/models.ts#L9-L47), and [configuration](https://github.com/starhunt/star-cliproxy/blob/91b7167f898b824f4793ee1ecc771de8c780b457/config.example.yaml#L1-L19); [agent-cli-to-api coverage](https://github.com/leeguooooo/agent-cli-to-api/blob/51c2758a07cf60724c0501f88a06cc3a89623427/README.md#L9-L18), [client routes](https://github.com/leeguooooo/agent-cli-to-api/blob/51c2758a07cf60724c0501f88a06cc3a89623427/codex_gateway/server.py#L1584-L1979), and [launcher defaults](https://github.com/leeguooooo/agent-cli-to-api/blob/51c2758a07cf60724c0501f88a06cc3a89623427/codex_gateway/cli.py#L55-L77); [CLIProxyAPI routes](https://github.com/router-for-me/CLIProxyAPI/blob/e99a2056baa981345f4a93600039725363ffca46/internal/api/server.go#L507-L562), [login providers](https://github.com/router-for-me/CLIProxyAPI/blob/e99a2056baa981345f4a93600039725363ffca46/cmd/server/main.go#L93-L104), [provider channels](https://github.com/router-for-me/CLIProxyAPI/blob/e99a2056baa981345f4a93600039725363ffca46/config.example.yaml#L379-L382), and [configuration](https://github.com/router-for-me/CLIProxyAPI/blob/e99a2056baa981345f4a93600039725363ffca46/config.example.yaml#L1-L42); [ChatMock OpenAI routes](https://github.com/RayBytes/ChatMock/blob/7a14223d68ff23e8eb200d5fb4825bfc569ed8f4/chatmock/routes_openai.py#L99-L720), [Ollama routes](https://github.com/RayBytes/ChatMock/blob/7a14223d68ff23e8eb200d5fb4825bfc569ed8f4/chatmock/routes_ollama.py#L57-L163), [WebSocket](https://github.com/RayBytes/ChatMock/blob/7a14223d68ff23e8eb200d5fb4825bfc569ed8f4/chatmock/websocket_routes.py#L70-L72), and [reflective CORS](https://github.com/RayBytes/ChatMock/blob/7a14223d68ff23e8eb200d5fb4825bfc569ed8f4/chatmock/http.py#L6-L15); [llm-cli-proxy routes](https://github.com/slopedrop/llm-cli-proxy/blob/54baac678b08bf5aab0ac6826c00ce3c6141e292/src/server.ts#L12-L20) and [server defaults](https://github.com/slopedrop/llm-cli-proxy/blob/54baac678b08bf5aab0ac6826c00ce3c6141e292/src/server.ts#L25-L47).

#### Measurement method

- "Active backend" means an integration documented and present in the pinned source. A subprocess CLI, direct OAuth provider, and hybrid backend are labeled separately instead of being treated as identical.
- "Client API surface" counts distinct public method/path pairs used by clients and excludes health/docs. Aliases count because clients depend on their paths; schema names are shown to keep the number meaningful.
- npm and Python footprints were measured from clean production installs with `npm install --omit=dev` or a fresh virtualenv and `du -sb`. cli2api's single bundle includes its JavaScript libraries and ships their versions/licenses in `THIRD_PARTY_NOTICES.txt`; the package has no runtime npm dependency graph. The cli2api result used Node 24/npm on Linux x86-64. Go uses the published Linux archive and extracted binary. These numbers compare shipped/runtime software, not a globally installed provider CLI or language runtime.
- The final cli2api values are the rounded output of `npm pack --dry-run --json` and `du -sb` on a fresh tarball install.
- Sizes are local measurements at the pinned revisions and can vary slightly by package-manager metadata and filesystem. Rounded decimal kB is used for tiny archives; installed sizes are MiB.
- Security describes the out-of-box listener/auth/CORS behavior, not every available hardening option.

### Reproducible gateway benchmark

`npm run bench` builds cli2api, starts the mock adapter on an ephemeral authenticated port, warms it up, then issues 1,000 valid Chat Completions at concurrency 32. It reports cold start, throughput, p50/p95/p99 latency, idle RSS, and post-run RSS as JSON.

```bash
npm run bench
CLI2API_BENCH_REQUESTS=1000 CLI2API_BENCH_CONCURRENCY=1 npm run bench
```

A single local run on 2026-07-11 (Linux x64, Node 24.14.1, 4-core AMD A10-8700P) produced:

| Concurrency | Throughput | p50 | p95 | p99 | Cold start | Idle / post-run RSS |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 193.8 req/s | 4.47 ms | 9.43 ms | 17.47 ms | 607.6 ms | 63.8 / 107.6 MiB |
| 32 | 322.0 req/s | 87.42 ms | 188.58 ms | 260.39 ms | 408.0 ms | 63.8 / 110.3 MiB |

These are transparent observations, not a cross-project victory claim: this measures HTTP/gateway overhead with the built-in mock, not model or subprocess startup speed. Results depend on the machine and should not be compared with competitors unless the same harness, host, runtime, request, and concurrency are used. Cursor, Claude, Gemini, and Qwen forward native partial events; Codex and OpenCode re-chunk completed messages with zero delay; Copilot output is buffered.

### One-board end-to-end benchmark

The companion [benchmark_scrabble](https://github.com/cochon123/benchmark_scrabble) project exercises a real CLI through the OpenRouter-compatible path. Keep the smoke run cheap and prevent the adapter from reading benchmark data by giving it an empty directory:

```bash
git clone https://github.com/cochon123/benchmark_scrabble.git
cd benchmark_scrabble
scratch="$(mktemp -d)"

cli2api run --adapter codex --model codex/gpt-5.5 --cwd "$scratch" -- \
  python3 -m scrabble_bench run \
    --model cli2api/codex/gpt-5.5 \
    --preset custom --boards 1 --reasoning-effort low --concurrency 1
```

One board is an end-to-end routing/format/authentication check, not a statistically meaningful model-quality ranking.

The run performed for this branch used benchmark commit [`2ca2d64`](https://github.com/cochon123/benchmark_scrabble/commit/2ca2d649c024ad7b61ec2c85b78ba40a5c034f8d), Codex CLI 0.144.1, `gpt-5.5`, and low reasoning:

| Board | Result | Calls / retries | Timing and reported usage |
|---|---:|---|---|
| `pos-1-6` | **28 / 40 points (70%)**, legal move | 2 gateway model calls; benchmark attempt 1; no legality retry | 203.3 s run wall time; successful fallback 105.7 s; 16,311 tokens reported for the final call |

The harness opened a stream first, then applied its own 60-second no-model-token rule and retried once without streaming. That transport fallback explains the two calls; cli2api routed both through the authenticated OpenRouter-compatible path from the empty scratch cwd.

## Security model

Defaults are intentionally useful before any configuration:

- The listener accepts only loopback hosts. Every route, including health and models, requires a bearer token or `x-api-key` checked with timing-safe equality.
- There is no CORS middleware. An arbitrary browser tab cannot read local agent output through cross-origin `fetch`.
- Without `--project`, `--cwd`, or configured `cwd`, adapters see a fresh empty temporary workspace that is removed on normal exit.
- CLI subprocesses use argv arrays with `shell: false`, restrictive read/plan modes, and a scrubbed environment. Only runtime paths, the adapter's narrowly scoped authentication variables, and explicitly allowlisted variables are inherited.
- Defaults cap request bodies at 2 MiB, API-visible adapter output at 4 MiB/10,000 events, raw streaming process output at 8 MiB, and live subprocesses at 2 per adapter. The global adapter queue and each explicit Chat-session queue are independently bounded at 16; full queues fail with HTTP 429.
- Disconnects, timeouts, and graceful shutdown terminate the POSIX subprocess group or make a best-effort Windows process-tree termination. Session state and health/capability caches are bounded.
- `cli2api run` adds loopback hosts to both `NO_PROXY` forms before giving a generated bearer token to the wrapped client, preventing inherited proxy settings from redirecting local SDK traffic.
- Responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a restrictive CSP, and a request ID.
- Config is schema-validated. cli2api automatically reads only `$XDG_CONFIG_HOME/cli2api/config.json`; it does **not** trust a repository's `.cli2api.json` merely because you entered that directory.

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability reporting policy. You remain responsible for each CLI vendor's terms and for protecting its local login.

## Configuration

The user config is `$XDG_CONFIG_HOME/cli2api/config.json` (normally `~/.config/cli2api/config.json`). Trust another file explicitly with `--config path/to/file.json` or `CLI2API_CONFIG`; explicit values override the user config. A project `.cli2api.json` is ignored unless explicitly named.

```json
{
  "defaultAdapter": "codex",
  "port": 3927,
  "cwd": "/work/repo",
  "maxConcurrency": 2,
  "maxQueue": 16,
  "maxBodyBytes": 2097152,
  "binaries": {
    "codex": "codex",
    "opencode": "opencode",
    "cursor": "cursor-agent",
    "claude": "claude",
    "gemini": "gemini",
    "qwen": "qwen",
    "copilot": "copilot"
  }
}
```

Common environment variables:

| Variable | Meaning |
|---|---|
| `CLI2API_ADAPTER` | Default adapter; `serve` and `run` also accept `auto` |
| `CLI2API_TOKEN` | Required API secret; generated per process if omitted |
| `CLI2API_PORT` | Server port |
| `CLI2API_CWD` | Directory visible to CLI adapters |
| `CLI2API_CONFIG` | Explicit trusted JSON config path |
| `CLI2API_MAX_CONCURRENCY` | Live subprocesses per adapter, default `2` |
| `CLI2API_MAX_QUEUE` | Waiting requests per adapter, default `16` |
| `CLI2API_MAX_BODY_BYTES` | Request cap, default `2097152` |
| `CLI2API_{CODEX,OPENCODE,CURSOR,CLAUDE,GEMINI,QWEN,COPILOT}_BIN` | Override a CLI binary path |
| `CLI2API_CHILD_ENV_ALLOWLIST` | Comma-separated exceptional parent variables to pass to CLI children |
| `CLI2API_OPENROUTER_CATALOG` | `runnable` (default) or `mirror` |
| `OPENROUTER_API_KEY` | Optional, used only for canonical OpenRouter metadata refresh |

## Development

Requires Node.js 20 or newer:

```bash
git clone https://github.com/cochon123/cli2api.git
cd cli2api
npm ci
npm run verify
npm run build
npm run dev -- completion -m mock/echo -p "hello"
```

`npm test` is an alias for the verification suite; `npm run test:package` installs and executes the packed zero-dependency artifact. CI runs type checking, adapter contract fixtures, HTTP/API smoke tests, a full bundled-dependency audit, and package validation on Node 20, 22, and 24, plus Windows coverage on Node 24. CodeQL and Dependabot are configured separately.

## Current limits

- This is localhost, single-user software. There is no TLS, tenant isolation, durable session database, distributed scheduling, or horizontal clustering.
- Workspace isolation changes the CLI's starting directory; it is not an OS sandbox or a boundary against a malicious locally installed CLI, user-level CLI configuration, or machine-admin policy. Cursor headless mode receives `--trust`; selecting `--project` or `--cwd` therefore auto-acknowledges that workspace.
- Compatibility targets common OpenAI Chat/Responses, Anthropic Messages, and OpenRouter use; vendor extensions without a CLI equivalent may be accepted as metadata or ignored.
- The 2 MiB HTTP body ceiling is an outer safety cap, not a guaranteed prompt size: CLIs receive prompts as one argument, so operating-system argv limits can reject substantially smaller requests (especially on Windows).
- Coding CLIs change their headless flags and event formats. Fixture tests catch known contracts, while `doctor` catches many installed-version mismatches; a newly released CLI can still require an adapter update.
- Function calling is a validated prompt-envelope fallback, not a shared native tool bus.
- The default security policy prevents writes and unrestricted shell access. Some vendor read/plan modes can still perform read-only or sandboxed terminal inspection. cli2api is an inference/evaluation gateway, not an endpoint for remotely granting mutation privileges.
- Actual model latency, quotas, context length, pricing, and data handling come from the selected CLI/provider, not cli2api.

## License

MIT
