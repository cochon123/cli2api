import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  NormalizedChatRequest,
} from "../types.js";

export function messageContentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part: ContentPart) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image_url") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Flatten OpenAI chat messages into a single prompt for CLI backends. */
export function messagesToPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const text = messageContentToText(msg.content).trim();
    if (!text) continue;
    const role = (msg.role || "user").toUpperCase();
    parts.push(`${role}:\n${text}`);
  }
  parts.push("ASSISTANT:");
  return parts.join("\n\n");
}

/** Extract just the last user message (useful for agent-mode CLIs). */
export function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messageContentToText(messages[i].content).trim();
    }
  }
  return messagesToPrompt(messages);
}

export function parseModelId(model: string): { adapter?: string; modelLocal: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { modelLocal: model };
  return {
    adapter: model.slice(0, slash),
    modelLocal: model.slice(slash + 1) || model,
  };
}

export function normalizeChatRequest(body: ChatCompletionRequest): NormalizedChatRequest {
  if (!body || typeof body !== "object") {
    throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
  }
  if (!body.model || typeof body.model !== "string") {
    throw Object.assign(new Error("`model` is required"), { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw Object.assign(new Error("`messages` must be a non-empty array"), { status: 400 });
  }

  const { modelLocal } = parseModelId(body.model);
  return {
    model: body.model,
    modelLocal,
    messages: body.messages,
    stream: Boolean(body.stream),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    raw: body,
  };
}

export function completionId(): string {
  return `chatcmpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function buildCompletionResponse(opts: {
  id: string;
  model: string;
  content: string;
  finishReason?: "stop" | "length" | "error";
  usage?: ChatCompletionResponse["usage"];
}): ChatCompletionResponse {
  return {
    id: opts.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.content },
        finish_reason: opts.finishReason ?? "stop",
      },
    ],
    usage: opts.usage,
  };
}

export function buildChunk(opts: {
  id: string;
  model: string;
  delta?: { role?: "assistant"; content?: string };
  finishReason?: "stop" | "length" | "error" | null;
}): ChatCompletionChunk {
  return {
    id: opts.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        delta: opts.delta ?? {},
        finish_reason: opts.finishReason ?? null,
      },
    ],
  };
}

export function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
