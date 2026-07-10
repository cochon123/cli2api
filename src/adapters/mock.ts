import type { Adapter } from "./types.js";
import type {
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";
import { lastUserMessage, messagesToPrompt } from "../protocol/openai.js";

const MODELS: ModelInfo[] = [
  {
    id: "mock/echo",
    object: "model",
    created: 0,
    owned_by: "cli2api",
    description: "Echoes the last user message (instant)",
  },
  {
    id: "mock/slow",
    object: "model",
    created: 0,
    owned_by: "cli2api",
    description: "Streams a short canned reply with delays",
  },
];

async function* echoChat(req: NormalizedChatRequest): AsyncGenerator<ChatEvent> {
  const last = lastUserMessage(req.messages) || messagesToPrompt(req.messages);
  const reply = `[mock/echo] ${last}`;
  // Fake-stream in small chunks so clients exercise SSE path
  const chunkSize = 24;
  for (let i = 0; i < reply.length; i += chunkSize) {
    yield { type: "delta", text: reply.slice(i, i + chunkSize) };
  }
  yield {
    type: "done",
    finishReason: "stop",
    usage: {
      prompt_tokens: Math.ceil(last.length / 4),
      completion_tokens: Math.ceil(reply.length / 4),
      total_tokens: Math.ceil((last.length + reply.length) / 4),
    },
  };
}

async function* slowChat(_req: NormalizedChatRequest): AsyncGenerator<ChatEvent> {
  const reply = "Hello from cli2api mock/slow. This is a streamed canned response.";
  for (const word of reply.split(" ")) {
    yield { type: "delta", text: word + " " };
    await new Promise((r) => setTimeout(r, 40));
  }
  yield { type: "done", finishReason: "stop" };
}

export function createMockAdapter(): Adapter {
  return {
    id: "mock",
    description: "Deterministic local adapter for smoke tests (no CLI required)",

    async listModels() {
      return MODELS;
    },

    async *chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      if (signal.aborted) {
        yield { type: "error", message: "Aborted", code: "abort" };
        return;
      }
      if (req.modelLocal === "slow" || req.model === "mock/slow") {
        yield* slowChat(req);
        return;
      }
      yield* echoChat(req);
    },

    async health(): Promise<HealthStatus> {
      return {
        ok: true,
        adapter: "mock",
        details: { models: MODELS.map((m) => m.id) },
        message: "mock adapter ready",
      };
    },

    async doctor(): Promise<DoctorReport> {
      return {
        adapter: "mock",
        ok: true,
        checks: [
          { name: "always-available", ok: true, detail: "no binary required" },
          { name: "echo-model", ok: true, detail: "mock/echo" },
          { name: "slow-model", ok: true, detail: "mock/slow" },
        ],
      };
    },
  };
}
