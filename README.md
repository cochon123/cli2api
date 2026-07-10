# cli2api

Local OpenAI-compatible gateway for coding CLIs.

Point any OpenAI SDK / benchmark at localhost and run against **Codex** (or the built-in mock) using the same credentials / login you already have in the CLI.

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

## Use Codex (real CLI)

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
| `CLI2API_ADAPTER` | Default adapter (`mock` \| `codex`) |
| `CLI2API_TOKEN` | Bearer token (auto-generated for the session if unset) |
| `CLI2API_CODEX_BIN` | Path/name of Codex binary |
| `CLI2API_CWD` | Working directory for CLI adapters |

## API (subset)

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` — non-stream + `stream: true` (SSE)

All endpoints require `Authorization: Bearer <token>`.

Model ids: `adapter/model` — e.g. `mock/echo`, `codex/default`, `codex/o3`.

## Phase 0 scope

- [x] OpenAI chat completions + models
- [x] Mock adapter (instant env-swap proof)
- [x] Codex adapter via `codex exec --json`
- [x] Loopback-only bind + `doctor` / `completion`
- [x] Required bearer token (auto-generated if unset)
- [x] No open CORS (SDK/script clients only)
- [ ] OpenCode / cursor-agent adapters
- [x] Real JSONL streaming from Codex (`codex exec --json` line-by-line)
  - Pre-answer events → `delta.reasoning` / `reasoning_content`
  - Final `agent_message` → word-by-word fake-stream on `delta.content`
- [ ] Tool calling / Responses API
- [ ] Env scrubbing for spawned CLI processes (child still inherits parent env today)

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
- **Not yet:** child env scrubbing — spawned CLIs currently inherit the full parent environment. Tracked for a later phase.
- You are responsible for complying with each CLI vendor’s terms for local use.
