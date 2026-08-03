# cli2api

Local OpenAI- and OpenRouter-compatible gateway for coding CLIs.

Point any OpenAI SDK / benchmark at localhost and run against **Codex, OpenCode, Cursor Agent, or Claude Code** (plus the built-in mock) using the credentials/login already configured in each CLI.

> **Local only.** Binds to `127.0.0.1` by default. Not a multi-tenant product. Do not expose your CLI auth to the network.

## 30-second start

Install the published package globally:

```bash
npm install --global @cochon123/cli2api
cli2api serve --adapter mock --port 3927
```

The npm package is scoped because the unscoped `cli2api` name is already owned by another publisher. The installed executable is still named `cli2api`.

Before the first npm release, or to install the current GitHub version directly:

```bash
npm install --global github:cochon123/cli2api
cli2api --version
```

For development from a checkout:

```bash
# from the project root
npm install
npm run serve -- --adapter mock --port 3927
```

The server prints a generated bearer token on stderr if you did not set one. Copy it into your client env:

```bash
OPENAI_BASE_URL=http://127.0.0.1:3927/v1
OPENAI_API_KEY=<token printed by serve>
OPENAI_MODEL=mock/echo
```

Or pin the token yourself:

```bash
CLI2API_TOKEN=dev-secret npm run serve -- --adapter mock
# OPENAI_API_KEY=dev-secret
```

Smoke:

```bash
npm run test:smoke
npm run doctor
npm run dev -- completion -m mock/echo -p "hello"
```

## Use a real CLI

Requires [`codex`](https://github.com/openai/codex) on your `PATH` and logged in.

```bash
npm run doctor -- --adapter codex
npm run serve -- --adapter codex --port 3927
```

```bash
OPENAI_BASE_URL=http://127.0.0.1:3927/v1
OPENAI_API_KEY=<token printed by serve>
OPENAI_MODEL=codex/default
```

One-shot without the server:

```bash
npm run dev -- completion -m codex/default -p "Reply with exactly: pong"
```

The other adapters use the same commands and model-prefix routing:

```bash
# OpenCode: completed JSON reasoning/text blocks, safe `plan` agent, plugins disabled
npm run completion -- -m opencode/deepseek-v4-flash-free -p "Reply with: pong"

# Cursor: native partial reasoning/content deltas, read-only ask mode + sandbox
npm run completion -- -m cursor/composer-2.5-fast -p "Reply with: pong"

# Claude Code: native partial stream-json, plan mode, all built-in/MCP tools disabled
npm run completion -- -m claude/default -p "Reply with: pong"
```

Claude Code is implemented from its official headless CLI contract but was not live-tested on the development machine because `claude` was not installed.

## CLI

| Command | Purpose |
|---------|---------|
| `cli2api serve` | Start HTTP gateway |
| `cli2api doctor` | Check adapters / binaries (`--json`) |
| `cli2api models` | List model ids |
| `cli2api completion` | Smoke a prompt |
| `cli2api adapters` | List adapters |

```bash
npx tsx src/index.ts serve --help
```

After `npm run build`, the bin is `cli2api`.

## Env vars

| Var | Meaning |
|-----|---------|
| `CLI2API_ADAPTER` | Default adapter (`mock` \| `codex` \| `opencode` \| `cursor` \| `claude`) |
| `CLI2API_TOKEN` | Bearer token (auto-generated for the session if unset) |
| `CLI2API_CODEX_BIN` | Path/name of Codex binary |
| `CLI2API_OPENCODE_BIN` | Path/name of OpenCode binary |
| `CLI2API_CURSOR_BIN` | Path/name of Cursor Agent binary |
| `CLI2API_CURSOR_ISOLATED` | Set to `1` to run each Cursor request in a fresh empty temporary workspace |
| `CLI2API_CURSOR_HIDE_PATHS` | On Linux, hide `:`-separated directories from isolated Cursor requests using a private mount namespace |
| `CLI2API_CLAUDE_BIN` | Path/name of Claude Code binary |
| `CLI2API_CWD` | Working directory for CLI adapters |
| `CLI2API_CHILD_ENV_ALLOWLIST` | Comma-separated extra parent env names to explicitly pass to child CLIs |
| `CLI2API_CONFIG` | Explicit JSON config path |
| `CLI2API_OPENROUTER_CATALOG` | OpenRouter catalog mode (`runnable` or `mirror`) |
| `OPENROUTER_API_KEY` | Optional key used only to refresh OpenRouter model metadata |

## Config and model aliases

JSON config is merged in this order: `$XDG_CONFIG_HOME/cli2api/config.json`, project `.cli2api.json`, then `--config <path>` / `CLI2API_CONFIG`. Later values win; `modelAliases` and `binaries` merge by key.

```json
{
  "defaultAdapter": "opencode",
  "port": 3927,
  "token": "local-secret",
  "cwd": "/path/to/project",
  "modelAliases": {
    "fast": "opencode/deepseek-v4-flash-free",
    "composer": "cursor/composer-2.5-fast"
  },
  "openRouter": {
    "defaultModel": "anthropic/claude-sonnet-4",
    "catalogMode": "runnable",
    "annotateAvailability": true,
    "pricingEnabled": true,
    "pricingModelMappings": {
      "cursor/cursor-grok-4.5-high": "x-ai/grok-4.5"
    },
    "modelRoutes": {
      "anthropic/claude-sonnet-4": {
        "adapter": "claude",
        "model": "sonnet"
      },
      "openai/gpt-local": {
        "adapter": "codex",
        "model": "default"
      }
    }
  },
  "binaries": {
    "codex": "codex",
    "opencode": "opencode",
    "cursor": "cursor-agent",
    "claude": "claude"
  }
}
```

Aliases appear in `/v1/models` and work anywhere a model id is accepted.

## API (subset)

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` — non-stream + `stream: true` (SSE)
- `POST /v1/responses` — text/function input, non-stream + semantic SSE events
- `GET /api/v1/models` — OpenRouter-compatible model catalog
- `POST /api/v1/chat/completions` — OpenRouter-compatible chat, tools, reasoning, and SSE
- `POST /api/v1/responses` — OpenRouter path alias for the Responses subset

All endpoints require `Authorization: Bearer <token>`.

Model ids: `adapter/model` — e.g. `mock/echo`, `codex/default`, `opencode/deepseek-v4-flash-free`, `cursor/composer-2.5-fast`, `claude/sonnet`. OpenCode provider-qualified models keep the second slash, for example `opencode/openrouter/deepseek/deepseek-v4-flash`.

## OpenRouter compatibility

Point an OpenRouter-oriented client at `http://127.0.0.1:3927/api/v1` and use the same cli2api bearer token. Public OpenRouter model ids are mapped to local CLI models with `openRouter.modelRoutes`; the public id is preserved in responses while routing stays internal.

If an application relies on OpenRouter's account-level default and omits `model`, set `openRouter.defaultModel` locally.

The OpenRouter catalog has two modes:

- `runnable` (default) lists only models cli2api can execute. Configured OpenRouter ids are enriched with metadata from OpenRouter's models API.
- `mirror` returns the cached OpenRouter catalog so model discovery resembles production. Models without a local route remain visible but return a `model_not_available` error when called.

Select the mode in config or with `cli2api serve --openrouter-catalog runnable|mirror`.

Metadata is cached for 24 hours at `$XDG_CACHE_HOME/cli2api/openrouter-models.json` (or `~/.cache/cli2api/openrouter-models.json`). Stale data is used if refresh fails. Configure `metadataTtlSeconds`, `metadataCachePath`, or `metadataUrl` under `openRouter` when needed.

When a native CLI reports token usage, cli2api uses that cached catalog to add `usage.cost` and `usage.cost_details`. This is an **OpenRouter-equivalent estimate**, not the amount charged by a CLI subscription. Set `openRouter.pricingEnabled` to `false` to disable it. Common OpenAI, Anthropic, Google, DeepSeek, and xAI ids are inferred; use `pricingModelMappings` for CLI-specific ids or aliases. Unknown models keep their token usage and omit cost instead of inventing a price. Streaming `/v1/chat/completions` requests receive the final usage/cost chunk when `stream_options.include_usage` is true; `/api/v1` includes it automatically.

For safety, `OPENROUTER_API_KEY` is sent only to the canonical `https://openrouter.ai` origin. Custom `metadataUrl` sources never receive it. Cache entries are tied to their source URL so catalogs cannot be mixed across sources.

Set `annotateAvailability` to `true` to add a `cli2api` object to model records with local availability and routing details. Set it to `false` in `mirror` mode for the closest upstream catalog shape.

OpenRouter cloud-only routing features such as provider fallback, billing, and plugins are accepted as request metadata but are not performed locally. Adapter capabilities still determine the actual result.

Function tools are accepted in both OpenAI API shapes. Because these coding CLIs do not expose a uniform native tool protocol, cli2api supplies the function schemas in the prompt and validates a strict JSON call envelope; it returns standard `tool_calls` / `function_call` output. Tool names and JSON argument objects are always validated, and `strict: true` arguments are validated against the supplied JSON Schema. The mock adapter has native deterministic tool events for tests.

For Chat Completions, reuse a client-chosen `session_id` to resume the CLI's native conversation. For Responses, pass the prior returned `id` as `previous_response_id`; unknown, expired, restarted, or adapter-mismatched ids return HTTP 400 instead of silently losing context. Mappings are adapter-bound, in memory, limited to 1,000 entries, and expire after 24 hours; restarting cli2api clears them. On native resume, only messages after the last assistant turn are sent, avoiding duplicate history. Responses `instructions` are forwarded as a developer message.

## Phase 0 scope

- [x] OpenAI chat completions + models
- [x] OpenRouter-compatible paths, model routing, catalog modes, reasoning, and streaming usage
- [x] Mock adapter (instant env-swap proof)
- [x] Codex adapter via `codex exec --json`
- [x] Loopback-only bind + `doctor` / `completion`
- [x] Required bearer token (auto-generated if unset)
- [x] No open CORS (SDK/script clients only)
- [x] OpenCode adapter (`run --format json --thinking`, safe `plan` agent)
- [x] Cursor Agent adapter (native partial `stream-json`, read-only `ask` mode)
- [x] Claude Code adapter (headless partial `stream-json`, restrictive flags; not live-tested locally)
- [x] Real JSONL streaming from Codex (`codex exec --json` line-by-line)
  - Enable reasoning summaries via `-c model_reasoning_summary=detailed` (+ supports / unhide)
  - Reasoning summary items → word-by-word `delta.reasoning` / `reasoning_content`
  - Final `agent_message` → word-by-word `delta.content`
  - Short lifecycle crumbs still go to reasoning without fake-stream delay
- [x] Config files + model aliases
- [x] Function tool calling (validated prompt-envelope fallback)
- [x] Responses API subset + semantic streaming events
- [x] Native CLI session resume (`session_id` / `previous_response_id`)
- [x] Env scrubbing for spawned CLI processes with a small runtime allowlist, per-adapter auth vars, and explicit opt-in passthrough

## Project layout

```
src/
  index.ts              # CLI
  adapters/             # mock, codex, registry
  protocol/openai.ts    # request/response shaping
  openrouter/catalog.ts # cached metadata and runnable/mirror model views
  server/               # Hono app + listen
  types.ts
scripts/smoke.ts
```

## Safety

- Default bind: `127.0.0.1` only (refuse non-loopback hosts).
- Bearer token required on every request; generated on startup if unset.
- No CORS middleware — browser tabs on the same machine cannot read responses via `fetch` from arbitrary origins.
- Codex adapter defaults to `--sandbox read-only` (blocks writes; does **not** block reading files the agent is asked about).
- Spawn uses argv arrays only (`shell: false`); no prompt concatenation into a shell string.
- Child processes receive a scrubbed environment. Normal runtime paths/local config homes and narrowly scoped adapter auth variables are retained; unrelated parent secrets are removed. Add exceptional keys explicitly with `CLI2API_CHILD_ENV_ALLOWLIST`.
- OpenCode runs with its `plan` agent and external plugins disabled.
- Cursor runs in read-only `ask` mode with its sandbox enabled; `--trust` only acknowledges the configured working directory for headless startup.
- For benchmarks or other prompts that must not inspect answer-bearing files, start the server with `--cursor-isolated` and `--cursor-hide-paths /path/to/benchmark:/path/to/backups` (or the matching environment variables). Each request receives a fresh temporary workspace, while the listed directories are empty only inside Cursor's private Linux mount namespace. The host filesystem is unchanged, and the workspace is removed when the request finishes. Mount masking requires permission to create mount namespaces (normally root or `CAP_SYS_ADMIN`).
- Claude runs in `plan` mode with built-in tools disabled and configured MCP tools excluded.
- You are responsible for complying with each CLI vendor’s terms for local use.
