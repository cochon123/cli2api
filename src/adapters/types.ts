import type {
  ChatEvent,
  DoctorReport,
  HealthStatus,
  ModelInfo,
  NormalizedChatRequest,
} from "../types.js";

export interface Adapter {
  readonly id: string;
  readonly description: string;
  listModels(): Promise<ModelInfo[]>;
  chat(req: NormalizedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  health(): Promise<HealthStatus>;
  doctor(): Promise<DoctorReport>;
}

export const MAX_RESPONSE_BYTES = 4 * 1_048_576;
export const MAX_RESPONSE_EVENTS = 10_000;

/** Bound cumulative model-controlled output before any protocol buffers it. */
export async function* limitChatEvents(
  events: AsyncIterable<ChatEvent>,
  maxBytes = MAX_RESPONSE_BYTES,
  maxEvents = MAX_RESPONSE_EVENTS,
): AsyncIterable<ChatEvent> {
  let bytes = 0;
  let count = 0;
  for await (const event of events) {
    count += 1;
    if (count > maxEvents) {
      yield {
        type: "error",
        message: `CLI response exceeds the ${maxEvents}-event safety limit`,
        code: "event_limit",
      };
      return;
    }
    if (event.type === "delta") {
      bytes += Buffer.byteLength(event.text);
    } else if (event.type === "tool_call") {
      bytes += Buffer.byteLength(event.call.id)
        + Buffer.byteLength(event.call.function.name)
        + Buffer.byteLength(event.call.function.arguments);
    } else if (event.type === "session") {
      bytes += Buffer.byteLength(event.id);
    } else if (event.type === "error") {
      bytes += Buffer.byteLength(event.message) + (event.code ? Buffer.byteLength(event.code) : 0);
    }
    if (bytes > maxBytes) {
      yield {
        type: "error",
        message: `CLI response exceeds the ${maxBytes}-byte safety limit`,
        code: "output_limit",
      };
      return;
    }
    yield event;
  }
}

export function collectChatText(events: AsyncIterable<ChatEvent>): Promise<{
  text: string;
  reasoning: string;
  finishReason: "stop" | "length" | "tool_calls" | "error";
  usage?: import("../types.js").ChatCompletionResponse["usage"];
  error?: string;
  toolCalls: import("../types.js").ToolCall[];
  nativeSessionId?: string;
}> {
  return (async () => {
    let text = "";
    let reasoning = "";
    let finishReason: "stop" | "length" | "tool_calls" | "error" = "stop";
    let usage: import("../types.js").ChatCompletionResponse["usage"];
    let error: string | undefined;
    const toolCalls: import("../types.js").ToolCall[] = [];
    let nativeSessionId: string | undefined;

    for await (const ev of events) {
      if (ev.type === "delta") {
        if ((ev.channel ?? "content") === "content") text += ev.text;
        else reasoning += ev.text;
      } else if (ev.type === "done") {
        finishReason = ev.finishReason;
        usage = ev.usage;
      } else if (ev.type === "error") {
        error = ev.message;
        finishReason = "error";
      } else if (ev.type === "tool_call") {
        toolCalls.push(ev.call);
      } else if (ev.type === "session") {
        nativeSessionId = ev.id;
      }
    }
    return { text, reasoning, finishReason, usage, error, toolCalls, nativeSessionId };
  })();
}
