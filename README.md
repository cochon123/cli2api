# cli2api

Local OpenAI-compatible gateway for coding CLIs.

Point any OpenAI SDK / benchmark at localhost and run against **Codex, OpenCode, Cursor Agent, or Claude Code** (plus the built-in mock) using the credentials/login already configured in each CLI.

> **Local only.** Binds to `127.0.0.1` by default. Not a multi-tenant product. Do not expose your CLI auth to the network.

## 30-second start

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
| `CLI2API_CLAUDE_BIN` | Path/name of Claude Code binary |
| `CLI2API_CWD` | Working directory for CLI adapters |
| `CLI2API_CHILD_ENV_ALLOWLIST` | Comma-separated extra parent env names to explicitly pass to child CLIs |
| `CLI2API_CONFIG` | Explicit JSON config path |

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

All endpoints require `Authorization: Bearer <token>`.

Model ids: `adapter/model` — e.g. `mock/echo`, `codex/default`, `opencode/deepseek-v4-flash-free`, `cursor/composer-2.5-fast`, `claude/sonnet`. OpenCode provider-qualified models keep the second slash, for example `opencode/openrouter/deepseek/deepseek-v4-flash`.

Function tools are accepted in both OpenAI API shapes. Because these coding CLIs do not expose a uniform native tool protocol, cli2api supplies the function schemas in the prompt and validates a strict JSON call envelope; it returns standard `tool_calls` / `function_call` output. The mock adapter has native deterministic tool events for tests.

For Chat Completions, reuse a client-chosen `session_id` to resume the CLI's native conversation. For Responses, pass the prior returned `id` as `previous_response_id`. Mappings are adapter-bound, in memory, limited to 1,000 entries, and expire after 24 hours; restarting cli2api clears them. On native resume, only messages after the last assistant turn are sent, avoiding duplicate history.

## Phase 0 scope

- [x] OpenAI chat completions + models
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
- Claude runs in `plan` mode with built-in tools disabled and configured MCP tools excluded.
- You are responsible for complying with each CLI vendor’s terms for local use.
