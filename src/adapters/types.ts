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
  finishReason: "stop" | "length" | "error";
  usage?: import("../types.js").ChatCompletionResponse["usage"];
  error?: string;
}> {
  return (async () => {
    let text = "";
    let finishReason: "stop" | "length" | "error" = "stop";
    let usage: import("../types.js").ChatCompletionResponse["usage"];
    let error: string | undefined;

    for await (const ev of events) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "done") {
        finishReason = ev.finishReason;
        usage = ev.usage;
      } else if (ev.type === "error") {
        error = ev.message;
        finishReason = "error";
      }
    }
    return { text, finishReason, usage, error };
  })();
}
