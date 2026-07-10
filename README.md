# cli2api

Local OpenAI-compatible gateway for coding CLIs.

Point any OpenAI SDK / benchmark at localhost and run against **Codex** (or the built-in mock) using the same credentials / login you already have in the CLI.

> **Local only.** Binds to `127.0.0.1` by default. Not a multi-tenant product. Do not expose your CLI auth to the network.

## 30-second start

```bash
cd Documents/mini-project/cli2api
npm install
npm run serve -- --adapter mock --port 3927
```

In your app / `.env`:

```bash
OPENAI_BASE_URL=http://127.0.0.1:3927/v1
OPENAI_API_KEY=local-dev
OPENAI_MODEL=mock/echo
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
OPENAI_API_KEY=local-dev
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
| `CLI2API_TOKEN` | Optional bearer token (clients must send matching `Authorization`) |
| `CLI2API_CODEX_BIN` | Path/name of Codex binary |
| `CLI2API_CWD` | Working directory for CLI adapters |

## API (subset)

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` — non-stream + `stream: true` (SSE)

Model ids: `adapter/model` — e.g. `mock/echo`, `codex/default`, `codex/o3`.

## Phase 0 scope

- [x] OpenAI chat completions + models
- [x] Mock adapter (instant env-swap proof)
- [x] Codex adapter via `codex exec --json`
- [x] Loopback-only bind + `doctor` / `completion`
- [ ] OpenCode / cursor-agent adapters
- [ ] True token streaming from CLI JSONL
- [ ] Tool calling / Responses API

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
- Codex adapter defaults to `--sandbox read-only`.
- You are responsible for complying with each CLI vendor’s terms for local use.
