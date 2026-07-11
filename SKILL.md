---
name: cli2api
description: >-
  Use cli2api to expose local coding CLIs (Codex, OpenCode, Cursor Agent,
  Claude Code, Gemini CLI, Qwen Code, GitHub Copilot CLI, and mock) as
  authenticated OpenAI, Anthropic, and OpenRouter-compatible APIs on localhost.
  Trigger when the user wants to wrap an API client around a local CLI, run an
  evaluation against a coding CLI, or set up cli2api run/serve/doctor.
---

# cli2api

Local-only OpenAI Chat/Responses, Anthropic Messages, and OpenRouter-compatible
gateway for coding CLIs.

## Quick path

```bash
# from the cli2api project root
npm install
npm run doctor -- --json
npm run dev -- run --adapter auto -- node my-agent.mjs

# persistent server for an orchestrator: dynamic port + one readiness JSON line
npm run serve -- --adapter auto --port 0 --json
```

`run` starts a temporary authenticated gateway, injects OpenAI, OpenRouter,
Anthropic, and `CLI2API_*` client variables, propagates the child's exit status,
and cleans up. `serve --port 0 --json` prints the chosen URLs, generated token,
selected adapter, health, model, and workspace as one readiness object on stdout.

Env for the client app:

```bash
OPENAI_BASE_URL=http://127.0.0.1:3927/v1
OPENAI_API_KEY=<token from serve or CLI2API_TOKEN>
OPENAI_MODEL=mock/echo
OPENROUTER_BASE_URL=http://127.0.0.1:3927/api/v1
OPENROUTER_API_KEY=<same token>
ANTHROPIC_BASE_URL=http://127.0.0.1:3927
ANTHROPIC_API_KEY=<same token>
ANTHROPIC_MODEL=mock/echo
```

Smoke without server: `npm run completion -- -m mock/echo -p "ping"`

## Rules

- Bind loopback only (`127.0.0.1`). Never suggest exposing on `0.0.0.0`.
- Always require a bearer token; never suggest disabling auth.
- Do not add CORS for browser pages unless the user explicitly wants a local UI
  with a pinned origin allowlist.
- Prefer `doctor --json` before blaming the client.
- Adapter ids are `codex`, `opencode`, `cursor`, `claude`, `gemini`, `qwen`,
  `copilot`, and `mock`. Model ids use `adapter/model` routing.
- `auto` selects an installed contract-ready CLI and falls back to mock.
- Unless `--project`, `--cwd`, or configured `cwd` is used, adapters receive a
  fresh empty temporary directory. This limits discovered project context but is
  not an OS sandbox; the CLI still runs as the current user.
- Codex needs `codex` on PATH and logged in; adapter uses `codex exec --json`
  with read-only sandbox by default.
- OpenCode uses a cli2api-owned deny-by-default `cli2api` agent in an isolated
  config home; external plugins, sharing, LSP downloads, and imports are disabled.
- Cursor uses fixed Ask mode and requests its sandbox. Claude uses safe/plan mode
  with setting sources, built-in tools, and MCP disabled; stateless requests also
  disable session persistence.
- Gemini uses plan mode plus a cli2api admin deny policy. Qwen uses safe/plan
  modes with mutating tools excluded and a zero tool-call cap. Copilot uses plan
  mode with read-only tools and remote/MCP/custom instructions disabled.
- Child environments are scrubbed. Use `CLI2API_CHILD_ENV_ALLOWLIST` only for
  additional variable names the selected CLI genuinely needs.
