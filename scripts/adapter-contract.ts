import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseOpenCodeLine, openCodeSessionId } from "../src/adapters/opencode.js";
import { buildCursorArgs, parseCursorLine } from "../src/adapters/cursor.js";
import { parseClaudeLine } from "../src/adapters/claude.js";
import { parseCodexLine } from "../src/adapters/codex.js";
import { parseGeminiLine } from "../src/adapters/gemini.js";
import { createQwenParser } from "../src/adapters/qwen.js";
import { createRegistry } from "../src/adapters/registry.js";
import { buildChildEnv, loopbackNoProxy, runCommand, runCommandLines, which } from "../src/util/process.js";
import { configPathFromArgv, loadConfig, withoutConfigArg } from "../src/config.js";
import { SessionStore } from "../src/session.js";
import { normalizeChatRequest } from "../src/protocol/openai.js";
import { parseToolCalls } from "../src/protocol/tools.js";
import { buildResponse, responsesToChat } from "../src/protocol/responses.js";
import { anthropicToChat, buildAnthropicMessage } from "../src/protocol/anthropic.js";
import { OpenRouterCatalog } from "../src/openrouter/catalog.js";
import { AdapterLimiter, QueueFullError } from "../src/server/limiter.js";
import { collectChatText, limitChatEvents } from "../src/adapters/types.js";
import { loopbackOrigin } from "../src/server/listen.js";

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

  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "codex-session" })), { kind: "session", sessionId: "codex-session" });
  assert.equal(openCodeSessionId(JSON.stringify({ sessionID: "open-session" })), "open-session");
  assert.deepEqual(parseCursorLine(JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-session" })), { kind: "session", id: "cursor-session" });
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" })), [{ kind: "session", id: "claude-session" }]);

  assert.deepEqual(parseGeminiLine(JSON.stringify({
    type: "init", session_id: "gemini-session", model: "gemini-test",
  })), [{ type: "session", id: "gemini-session" }]);
  assert.deepEqual(parseGeminiLine(JSON.stringify({
    type: "message", role: "assistant", content: "GEMINI_OK", delta: true,
  })), [{ type: "delta", text: "GEMINI_OK", channel: "content" }]);
  const geminiDone = parseGeminiLine(JSON.stringify({
    type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  }));
  assert.equal(geminiDone[0]?.type, "done");
  if (geminiDone[0]?.type === "done") assert.equal(geminiDone[0].usage?.total_tokens, 12);

  const qwen = createQwenParser();
  assert.deepEqual(qwen(JSON.stringify({
    type: "system", subtype: "session_start", session_id: "qwen-session",
  })), [{ type: "session", id: "qwen-session" }]);
  assert.deepEqual(qwen(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "QWEN_OK" } },
  })), [{ type: "delta", text: "QWEN_OK", channel: "content" }]);
  assert.deepEqual(qwen(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "QWEN_OK" }] },
  })), [], "Qwen final assistant message must not duplicate partial deltas");
  const qwenDone = qwen(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: "QWEN_OK", usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
  }));
  assert.equal(qwenDone[0]?.type, "done");
  if (qwenDone[0]?.type === "done") assert.equal(qwenDone[0].usage?.total_tokens, 12);
}

async function registryContract(): Promise<void> {
  const registry = createRegistry();
  assert.deepEqual(
    registry.list().map((adapter) => adapter.id),
    ["mock", "codex", "opencode", "cursor", "claude", "gemini", "qwen", "copilot"],
  );
  const models = (await Promise.all(registry.list().map((adapter) => adapter.listModels()))).flat();
  for (const id of [
    "codex/default",
    "opencode/deepseek-v4-flash-free",
    "cursor/composer-2.5-fast",
    "claude/default",
    "gemini/default",
    "qwen/default",
    "copilot/default",
  ]) {
    assert(models.some((model) => model.id === id), `missing model ${id}`);
  }
  assert.equal(registry.resolve("cursor/composer-2.5-fast", "mock").id, "cursor");
  assert.equal(registry.resolve("unprefixed-model", "mock").id, "mock");

  const aliases = createRegistry({ modelAliases: { fast: "cursor/composer-2.5-fast", nested: "fast" } });
  assert.equal(aliases.resolveModelId("nested"), "cursor/composer-2.5-fast");
  assert.equal(aliases.resolve("fast").id, "cursor");
  assert((await aliases.listModels()).some((model) => model.id === "fast"));
  assert.throws(() => createRegistry({ modelAliases: { a: "b", b: "a" } }).resolveModelId("a"), /cycle/);

  const routed = createRegistry({ modelRoutes: { "anthropic/claude-test": { adapter: "mock", model: "echo" } } });
  const routedReq = routed.normalizeRequest(normalizeChatRequest({
    model: "anthropic/claude-test",
    messages: [{ role: "user", content: "x" }],
  }));
  assert.equal(routedReq.model, "mock/echo");
  assert.equal(routedReq.modelLocal, "echo");
  assert.equal(routed.resolve(routedReq.model).id, "mock");

  const resilient = createRegistry();
  resilient.register({
    id: "broken",
    description: "probe failure fixture",
    async listModels() { return []; },
    async *chat() { yield { type: "done" as const, finishReason: "stop" as const }; },
    async health() { throw new Error("health exploded"); },
    async doctor() { throw new Error("doctor exploded"); },
  });
  const reports = await resilient.healthReports(0);
  assert.equal(reports.find((report) => report.adapter === "mock")?.ok, true);
  assert.equal(reports.find((report) => report.adapter === "broken")?.ok, false, "one broken optional CLI must not fail all readiness");
}

async function openRouterCatalogContract(): Promise<void> {
  const registry = createRegistry({ modelRoutes: { "anthropic/claude-test": { adapter: "mock", model: "echo" } } });
  const upstream = [
    { id: "anthropic/claude-test", name: "Claude Test", context_length: 200_000, supported_parameters: ["tools", "temperature"] },
    { id: "google/unavailable-test", name: "Unavailable Test", context_length: 1_000_000, supported_parameters: ["tools"] },
  ];
  const fetchImpl = async () => new Response(JSON.stringify({ data: upstream }), { headers: { "Content-Type": "application/json" } });
  const root = await mkdtemp(join(tmpdir(), "cli2api-catalog-"));

  const runnable = new OpenRouterCatalog(registry, {
    mode: "runnable",
    fetchImpl,
    metadataCachePath: join(root, "runnable.json"),
  });
  const runnableModels = await runnable.list();
  const routed = runnableModels.find((model) => model.id === "anthropic/claude-test");
  assert.equal(routed?.name, "Claude Test");
  assert.equal((routed?.cli2api as { available?: boolean })?.available, true);
  assert(!runnableModels.some((model) => model.id === "google/unavailable-test"));

  const mirror = new OpenRouterCatalog(registry, {
    mode: "mirror",
    annotateAvailability: false,
    fetchImpl,
    metadataCachePath: join(root, "mirror.json"),
  });
  const mirrorModels = await mirror.list();
  assert.deepEqual(mirrorModels, upstream);
  assert((await mirror.list(new URLSearchParams({ q: "unavailable" }))).some((model) => model.id === "google/unavailable-test"));

  const annotatedMirror = new OpenRouterCatalog(registry, {
    mode: "mirror",
    annotateAvailability: true,
    fetchImpl,
    metadataCachePath: join(root, "annotated-mirror.json"),
  });
  const annotatedModels = await annotatedMirror.list();
  assert.equal(
    (annotatedModels.find((model) => model.id === "anthropic/claude-test")?.cli2api as { available?: boolean })?.available,
    true,
  );
  assert.equal(
    (annotatedModels.find((model) => model.id === "google/unavailable-test")?.cli2api as { available?: boolean })?.available,
    false,
    "an unknown provider prefix must not fall through to the default adapter",
  );

  let customHeaders: HeadersInit | undefined;
  const custom = new OpenRouterCatalog(registry, {
    mode: "mirror",
    apiKey: "must-not-leak",
    metadataUrl: "https://metadata.example.test/models",
    metadataCachePath: join(root, "custom.json"),
    fetchImpl: async (_url, init) => {
      customHeaders = init?.headers;
      return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } });
    },
  });
  assert.deepEqual(await custom.list(), []);
  assert.equal(new Headers(customHeaders).has("Authorization"), false, "OpenRouter key must not be sent to custom metadata origins");
}

async function configContract(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cli2api-config-"));
  const xdg = join(root, "xdg");
  const cwd = join(root, "project");
  await mkdir(join(xdg, "cli2api"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(xdg, "cli2api", "config.json"), JSON.stringify({
    port: 4000,
    modelAliases: { fast: "mock/slow" },
    openRouter: { catalogMode: "mirror", modelRoutes: { "openai/test": { adapter: "mock", model: "slow" } } },
  }));
  await writeFile(join(cwd, ".cli2api.json"), JSON.stringify({
    port: 4001,
    modelAliases: { echo: "mock/echo" },
    openRouter: { catalogMode: "runnable", modelRoutes: { "anthropic/test": { adapter: "mock", model: "echo" } } },
  }));
  const loaded = await loadConfig({ cwd, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(loaded.port, 4000);
  assert.deepEqual(loaded.modelAliases, { fast: "mock/slow" });
  assert.equal(loaded.openRouter?.catalogMode, "mirror");
  assert.deepEqual(loaded.openRouter?.modelRoutes, {
    "openai/test": { adapter: "mock", model: "slow" },
  });

  const explicitlyTrusted = await loadConfig({
    cwd,
    explicitPath: join(cwd, ".cli2api.json"),
    env: { XDG_CONFIG_HOME: xdg },
  });
  assert.equal(explicitlyTrusted.port, 4001);
  assert.deepEqual(explicitlyTrusted.modelAliases, { fast: "mock/slow", echo: "mock/echo" });
  assert.equal(explicitlyTrusted.openRouter?.catalogMode, "runnable");
  assert.deepEqual(explicitlyTrusted.openRouter?.modelRoutes, {
    "openai/test": { adapter: "mock", model: "slow" },
    "anthropic/test": { adapter: "mock", model: "echo" },
  });

  await writeFile(join(cwd, ".cli2api.json"), JSON.stringify({ token: "known-repo-token", binaries: { codex: "./malicious" } }));
  const ignoredUntrusted = await loadConfig({ cwd, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(ignoredUntrusted.token, undefined);
  assert.deepEqual(ignoredUntrusted.binaries, {});
  const trustedOperational = await loadConfig({ cwd, explicitPath: ".cli2api.json", env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(trustedOperational.token, "known-repo-token");
  assert.equal(trustedOperational.binaries?.codex, "./malicious");
  assert.deepEqual(withoutConfigArg(["node", "cli2api", "models", "--config", "x.json", "--json"]), ["node", "cli2api", "models", "--json"]);
  const childArgs = ["node", "cli2api", "run", "--", "child", "--config", "child.json"];
  assert.equal(configPathFromArgv(childArgs), undefined);
  assert.deepEqual(withoutConfigArg(childArgs), childArgs, "child --config must survive the run separator");
}

function toolAndSessionContracts(): void {
  const cursorArgs = buildCursorArgs(normalizeChatRequest({
    model: "cursor/composer-2.5",
    messages: [{ role: "user", content: "inspect only" }],
  }));
  assert.deepEqual(cursorArgs.slice(0, 9), [
    "-p", "--output-format", "stream-json", "--stream-partial-output",
    "--mode", "ask", "--sandbox", "enabled", "--trust",
  ]);
  assert.equal(cursorArgs.includes("--force"), false);
  assert.equal(cursorArgs.includes("--yolo"), false);
  assert.equal(cursorArgs.includes("--approve-mcps"), false);
  assert.deepEqual(cursorArgs.slice(-3, -1), ["--model", "composer-2.5"]);

  const req = normalizeChatRequest({
    model: "mock/echo", messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "lookup" } }], tool_choice: "required",
  });
  const calls = parseToolCalls('{"tool_calls":[{"name":"lookup","arguments":{"q":"x"}}]}', req);
  assert.equal(calls[0]?.function.name, "lookup");
  assert.deepEqual(JSON.parse(calls[0]?.function.arguments ?? "{}"), { q: "x" });
  assert.equal(parseToolCalls('{"tool_calls":[{"name":"not_allowed","arguments":{}}]}', req).length, 0);

  const store = new SessionStore(2, 1000);
  store.set("response-1", "codex", "native-1");
  assert.equal(store.get("response-1", "codex"), "native-1");
  assert.equal(store.get("response-1", "cursor"), undefined);
  assert.equal(store.get("response-1", "codex"), "native-1", "adapter mismatch must not delete session");
  assert.equal(store.move("response-1", "response-2", "codex"), "native-1");
  assert.equal(store.get("response-1", "codex"), undefined);
  assert.equal(store.get("response-2", "codex"), "native-1");
  store.set("x".repeat(513), "codex", "native-too-large-key");
  assert.equal(store.get("x".repeat(513), "codex"), undefined);

  const strictReq = normalizeChatRequest({
    model: "mock/echo", messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: {
      name: "lookup", strict: true,
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
    } }], tool_choice: "required",
  });
  assert.equal(parseToolCalls('{"tool_calls":[{"name":"lookup","arguments":{"wrong":1}}]}', strictReq).length, 0);
  assert.equal(parseToolCalls('{"tool_calls":[{"name":"lookup","arguments":{"q":"ok"}}]}', strictReq).length, 1);
  assert.equal(parseToolCalls('{"tool_calls":[{"name":"lookup","arguments":"not-json"}]}', strictReq).length, 0);

  const responseChat = responsesToChat({ model: "mock/echo", instructions: "Always answer BANANA", input: "hello" });
  assert.deepEqual(responseChat.messages[0], { role: "developer", content: "Always answer BANANA" });
  assert.deepEqual(
    buildResponse({ id: "resp_failed", model: "mock/echo", status: "failed", error: { message: "nope" } }).output,
    [],
    "failed Responses objects must not fabricate a completed assistant message",
  );
  assert.throws(() => responsesToChat({
    model: "mock/echo", input: "x", previous_response_id: "chat-session",
  }), /cli2api response id/);
  assert.throws(() => normalizeChatRequest({
    model: "mock/echo", messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "" } }], tool_choice: "required",
  }), /name is required/);

  const anthropicChat = anthropicToChat({
    model: "mock/echo",
    max_tokens: 100,
    system: [{ type: "text", text: "Be concise" }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }] },
    ],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    tool_choice: { type: "any" },
  });
  assert.equal(anthropicChat.messages[0]?.role, "developer");
  assert.equal(anthropicChat.messages[1]?.tool_calls?.[0]?.function.name, "lookup");
  assert.equal(anthropicChat.messages[2]?.role, "tool");
  assert.equal(anthropicChat.tool_choice, "required");
  const anthropicMessage = buildAnthropicMessage({
    id: "msg_test", model: "mock/echo", text: "", finishReason: "tool_calls",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
  });
  assert.equal(anthropicMessage.stop_reason, "tool_use");
  assert.deepEqual(anthropicMessage.content[0], { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } });
}

function envContract(): void {
  assert.equal(loopbackOrigin("127.0.0.1", 3927), "http://127.0.0.1:3927");
  assert.equal(loopbackOrigin("::1", 3927), "http://[::1]:3927");
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
    assert.equal(
      loopbackNoProxy({ NO_PROXY: "internal.test", no_proxy: "localhost,legacy.test" }),
      "internal.test,localhost,legacy.test,127.0.0.1,::1,[::1]",
    );
  } finally {
    delete process.env[secretKey];
  }
}

async function timeoutContract(): Promise<void> {
  const relativeBinary = await which("./node_modules/.bin/tsx");
  assert(relativeBinary && isAbsolute(relativeBinary), "relative binary overrides must resolve before adapter cwd changes");
  const shimVersion = await runCommand(relativeBinary, ["--version"], { timeoutMs: 5_000 });
  assert.equal(shimVersion.code, 0, "resolved npm binary shim must be safely executable");

  const argvRoot = await mkdtemp(join(tmpdir(), "cli2api-argv-"));
  try {
    const argvScript = join(argvRoot, "argv.ts");
    const specialArgs = ["spaces here", "&", "|", ";", "%PATH%", "$()", "quote\"inside", "line1\nline2"];
    await writeFile(argvScript, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const argvResult = await runCommand(relativeBinary, [argvScript, ...specialArgs], { timeoutMs: 5_000 });
    assert.equal(argvResult.code, 0, `npm shim argv fixture failed: ${argvResult.stderr}`);
    assert.deepEqual(JSON.parse(argvResult.stdout.trim()), specialArgs, "npm shim must preserve model-controlled argv literally");
  } finally {
    await rm(argvRoot, { recursive: true, force: true });
  }

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

  let outputLimited = false;
  for await (const event of runCommandLines(process.execPath, [
    "-e",
    "const line='x'.repeat(1048000)+'\\n'; for(let i=0;i<9;i++) process.stdout.write(line)",
  ], { timeoutMs: 5_000 })) {
    if (event.type === "exit") outputLimited = event.outputLimitExceeded;
  }
  assert.equal(outputLimited, true, "raw JSONL traffic must have a cumulative cap");

  const treeScript = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], { stdio: 'ignore' })",
    "console.log(child.pid)",
    "process.on('SIGTERM', () => process.exit(0))",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const treeResult = await runCommand(process.execPath, ["-e", treeScript], { timeoutMs: 500 });
  const descendantPid = Number(treeResult.stdout.trim());
  assert.equal(treeResult.timedOut, true);
  assert(Number.isInteger(descendantPid) && descendantPid > 0, "tree fixture did not report descendant pid");
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  let descendantAlive = true;
  try { process.kill(descendantPid, 0); } catch { descendantAlive = false; }
  if (descendantAlive) {
    try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
  }
  assert.equal(descendantAlive, false, "timed-out subprocess descendant survived tree escalation");
}

async function limiterContract(): Promise<void> {
  const limiter = new AdapterLimiter(1, 1);
  const signal = new AbortController().signal;
  const releaseFirst = await limiter.acquire("mock", signal);
  const secondPromise = limiter.acquire("mock", signal);
  await assert.rejects(
    limiter.acquire("mock", signal),
    (error: unknown) => error instanceof QueueFullError,
  );
  assert.deepEqual(limiter.snapshot().mock, { active: 1, queued: 1 });
  releaseFirst();
  const releaseSecond = await secondPromise;
  releaseSecond();
  assert.deepEqual(limiter.snapshot().mock, { active: 0, queued: 0 });

  const events = async function* () {
    yield { type: "delta" as const, text: "123", channel: "content" as const };
    yield { type: "delta" as const, text: "456", channel: "content" as const };
    yield { type: "done" as const, finishReason: "stop" as const };
  };
  const capped = await collectChatText(limitChatEvents(events(), 5));
  assert.equal(capped.error, "CLI response exceeds the 5-byte safety limit");

  const emptyEvents = async function* () {
    for (let index = 0; index < 4; index += 1) {
      yield { type: "delta" as const, text: "", channel: "content" as const };
    }
  };
  const eventCapped = await collectChatText(limitChatEvents(emptyEvents(), 1_000, 3));
  assert.equal(eventCapped.error, "CLI response exceeds the 3-event safety limit");
}

parserContracts();
envContract();
toolAndSessionContracts();
await configContract();
await timeoutContract();
await limiterContract();
await registryContract();
await openRouterCatalogContract();
console.log("adapter contracts ok");
