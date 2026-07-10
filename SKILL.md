---
name: cli2api
description: >-
  Use cli2api to expose local coding CLIs (Codex, OpenCode, Cursor Agent,
  Claude Code, mock) as an OpenAI-compatible
  HTTP API on localhost. Trigger when the user wants to point OPENAI_BASE_URL at
  a local CLI, swap cloud API for Codex/OpenCode, run benchmarks against a local
  agent CLI, or set up cli2api serve/doctor/completion.
---

# cli2api

Local-only OpenAI-compatible gateway for coding CLIs.

## Quick path

```bash
# from the cli2api project root
npm install
npm run doctor -- --json
npm run serve -- --adapter mock --port 3927
# or: npm run serve -- --adapter codex --port 3927
# or: npm run serve -- --adapter opencode --port 3927
# or: npm run serve -- --adapter cursor --port 3927
# or: npm run serve -- --adapter claude --port 3927
```

On startup, if no token was set, the server prints a generated bearer token.
Use that value (or set `CLI2API_TOKEN` / `--token`) as `OPENAI_API_KEY`.

Env for the client app:

```bash
OPENAI_BASE_URL=http://127.0.0.1:3927/v1
OPENAI_API_KEY=<token from serve stderr or CLI2API_TOKEN>
OPENAI_MODEL=mock/echo
# OPENAI_MODEL=codex/default
```

Smoke without server: `npm run completion -- -m mock/echo -p "ping"`

## Rules

- Bind loopback only (`127.0.0.1`). Never suggest exposing on `0.0.0.0`.
- Always require a bearer token; never suggest disabling auth.
- Do not add CORS for browser pages unless the user explicitly wants a local UI
  with a pinned origin allowlist.
- Prefer `doctor --json` before blaming the client.
- Model ids are `adapter/model` (`mock/echo`, `codex/default`,
  `opencode/deepseek-v4-flash-free`, `cursor/composer-2.5-fast`, `claude/default`).
- Codex needs `codex` on PATH and logged in; adapter uses `codex exec --json`
  with read-only sandbox by default.
- OpenCode uses its read-only `plan` agent with external plugins disabled.
- Cursor Agent uses native partial stream-json in read-only `ask` mode with its
  sandbox enabled.
- Claude Code uses headless stream-json in plan mode with built-in/MCP tools
  disabled. Run `doctor --adapter claude` before use.
- Child environments are scrubbed. Use `CLI2API_CHILD_ENV_ALLOWLIST` only for
  additional variable names the selected CLI genuinely needs.
