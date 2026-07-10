import assert from "node:assert/strict";
import { parseOpenCodeLine } from "../src/adapters/opencode.js";
import { parseCursorLine } from "../src/adapters/cursor.js";
import { parseClaudeLine } from "../src/adapters/claude.js";
import { createRegistry } from "../src/adapters/registry.js";
import { buildChildEnv, runCommand } from "../src/util/process.js";

function parserContracts(): void {
  const openReasoning = parseOpenCodeLine(JSON.stringify({
    type: "reasoning",
    part: { type: "reasoning", text: "thinking" },
  }));
  assert.deepEqual(openReasoning, { kind: "reasoning", text: "thinking" });

  const openText = parseOpenCodeLine(JSON.stringify({
    type: "text",
    part: { type: "text", text: "OPENCODE_OK" },
  }));
  assert.deepEqual(openText, { kind: "content", text: "OPENCODE_OK" });

  const openFinish = parseOpenCodeLine(JSON.stringify({
    type: "step_finish",
    part: { reason: "stop", tokens: { total: 12, input: 10, output: 2 } },
  }));
  assert.equal(openFinish.kind, "finish");
  if (openFinish.kind === "finish") assert.equal(openFinish.usage?.total_tokens, 12);

  const cursorThinking = parseCursorLine(JSON.stringify({
    type: "thinking",
    subtype: "delta",
    text: "think",
    timestamp_ms: 1,
  }));
  assert.deepEqual(cursorThinking, { kind: "reasoning", text: "think", partial: true });

  const cursorPartial = parseCursorLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "CUR" }] },
    timestamp_ms: 1,
  }));
  assert.deepEqual(cursorPartial, { kind: "content", text: "CUR", partial: true });

  const cursorFinal = parseCursorLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "CURSOR_OK" }] },
  }));
  assert.deepEqual(cursorFinal, { kind: "content", text: "CURSOR_OK", partial: false });

  const claudeText = parseClaudeLine(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "CLAUDE" } },
  }));
  assert.deepEqual(claudeText, [{ kind: "content", text: "CLAUDE", partial: true }]);

  const claudeThinking = parseClaudeLine(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } },
  }));
  assert.deepEqual(claudeThinking, [{ kind: "reasoning", text: "think", partial: true }]);
}

async function registryContract(): Promise<void> {
  const registry = createRegistry();
  assert.deepEqual(
    registry.list().map((adapter) => adapter.id),
    ["mock", "codex", "opencode", "cursor", "claude"],
  );
  const models = (await Promise.all(registry.list().map((adapter) => adapter.listModels()))).flat();
  for (const id of [
    "codex/default",
    "opencode/deepseek-v4-flash-free",
    "cursor/composer-2.5-fast",
    "claude/default",
  ]) {
    assert(models.some((model) => model.id === id), `missing model ${id}`);
  }
  assert.equal(registry.resolve("cursor/composer-2.5-fast", "mock").id, "cursor");
  assert.equal(registry.resolve("unprefixed-model", "mock").id, "mock");
}

function envContract(): void {
  const secretKey = "CLI2API_TEST_SHOULD_NOT_LEAK";
  process.env[secretKey] = "secret";
  try {
    const scrubbed = buildChildEnv();
    assert.equal(scrubbed[secretKey], undefined);
    const optedIn = buildChildEnv({}, [secretKey]);
    assert.equal(optedIn[secretKey], "secret");
    const overridden = buildChildEnv({ [secretKey]: "explicit" });
    assert.equal(overridden[secretKey], "explicit");
    assert.equal(typeof scrubbed.PATH, "string");
  } finally {
    delete process.env[secretKey];
  }
}

async function timeoutContract(): Promise<void> {
  const started = Date.now();
  const script = process.platform === "win32"
    ? "setInterval(() => {}, 1000)"
    : [
        "const { spawn } = require('node:child_process')",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
        "setInterval(() => {}, 1000)",
      ].join(";");
  const result = await runCommand(
    process.execPath,
    ["-e", script],
    { timeoutMs: 100 },
  );
  assert.equal(result.timedOut, true);
  assert(Date.now() - started < 3_000, "timed-out child did not terminate promptly");
}

parserContracts();
envContract();
await timeoutContract();
await registryContract();
console.log("adapter contracts ok");
