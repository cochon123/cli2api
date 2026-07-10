/**
 * Manual check: Codex adapter yields reasoning then word-streamed content.
 * Usage: npx tsx scripts/stream-codex-check.ts
 */
import { createCodexAdapter, parseCodexLine, fakeStreamWords } from "../src/adapters/codex.js";
import { normalizeChatRequest } from "../src/protocol/openai.js";

async function unitParse() {
  const lines = [
    `{"type":"thread.started","thread_id":"t1"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking about the board"}}`,
    `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}}`,
    `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"hello stream world"}}`,
    `{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}`,
  ];
  console.log("--- parseCodexLine ---");
  for (const line of lines) {
    console.log(parseCodexLine(line));
  }
  console.log("--- fakeStreamWords ---");
  const words: string[] = [];
  for await (const ev of fakeStreamWords("hello stream world", 0)) {
    if (ev.type === "delta") words.push(ev.text);
  }
  console.log(words);
}

async function live() {
  const adapter = createCodexAdapter({
    timeoutMs: 120_000,
    skipGitRepoCheck: true,
    contentWordDelayMs: 20,
  });
  const req = normalizeChatRequest({
    model: "codex/default",
    messages: [{ role: "user", content: "Reply with exactly: STREAM_OK" }],
    stream: true,
  });
  const ac = new AbortController();
  const t0 = Date.now();
  let firstReasoning = 0;
  let firstContent = 0;
  let content = "";
  let reasoning = "";

  for await (const ev of adapter.chat(req, ac.signal)) {
    const t = Date.now() - t0;
    if (ev.type === "delta") {
      const ch = ev.channel ?? "content";
      if (ch === "reasoning") {
        if (!firstReasoning) firstReasoning = t;
        reasoning += ev.text;
        console.log(`[${t}ms] reasoning:`, JSON.stringify(ev.text));
      } else {
        if (!firstContent) firstContent = t;
        content += ev.text;
        console.log(`[${t}ms] content:`, JSON.stringify(ev.text));
      }
    } else if (ev.type === "done") {
      console.log(`[${t}ms] done`, ev.usage);
    } else {
      console.log(`[${t}ms]`, ev);
    }
  }

  console.log(
    `total ${Date.now() - t0}ms; firstReasoning ${firstReasoning}ms; firstContent ${firstContent}ms; content=${JSON.stringify(content)} reasoningChars=${reasoning.length}`,
  );
}

async function main() {
  await unitParse();
  if (process.argv.includes("--live")) {
    await live();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
