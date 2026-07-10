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
