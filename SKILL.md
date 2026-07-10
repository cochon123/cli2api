---
name: cli2api
description: >-
  Use cli2api to expose local coding CLIs (Codex, mock) as an OpenAI-compatible
  HTTP API on localhost. Trigger when the user wants to point OPENAI_BASE_URL at
  a local CLI, swap cloud API for Codex/OpenCode, run benchmarks against a local
  agent CLI, or set up cli2api serve/doctor/completion.
---

# cli2api

Local-only OpenAI-compatible gateway for coding CLIs.

## Quick path

```bash
cd /home/cochon/Documents/mini-project/cli2api   # or project root
npm install
npm run doctor -- --json
npm run serve -- --adapter mock --port 3927
# or: npm run serve -- --adapter codex --port 3927
```

Env for the client app:

```bash
OPENAI_BASE_URL=http://127.0.0.1:3927/v1
OPENAI_API_KEY=local-dev
OPENAI_MODEL=mock/echo
# OPENAI_MODEL=codex/default
```

Smoke without server: `npm run completion -- -m mock/echo -p "ping"`

## Rules

- Bind loopback only (`127.0.0.1`). Never suggest exposing on `0.0.0.0`.
- Prefer `doctor --json` before blaming the client.
- Model ids are `adapter/model` (`mock/echo`, `codex/default`).
- Codex needs `codex` on PATH and logged in; adapter uses `codex exec --json` with read-only sandbox.
