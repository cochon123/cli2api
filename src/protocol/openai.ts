import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  NormalizedChatRequest,
  ChatTool,
  ToolCall,
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
    const calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
      ? JSON.stringify({ tool_calls: msg.tool_calls })
      : "";
    if (!text && !calls) continue;
    const role = (msg.role || "user").toUpperCase();
    parts.push(`${role}:\n${text || calls}`);
  }
  parts.push("ASSISTANT:");
  return parts.join("\n\n");
}

function trailingMessages(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages.slice(index + 1);
  }
  return messages;
}

function toolInstructions(tools: ChatTool[], choice: NormalizedChatRequest["toolChoice"]): string {
  if (!tools.length || choice === "none") return "";
  const definitions = tools.map((tool) => tool.function);
  const forced = typeof choice === "object" ? choice.function.name : undefined;
  const requirement = forced
    ? `You must call the function named ${forced}.`
    : choice === "required"
      ? "You must call one or more functions."
      : "Call a function only when it is useful.";
  return [
    "AVAILABLE FUNCTIONS:",
    JSON.stringify(definitions),
    requirement,
    "To call functions, return only valid JSON in this exact shape:",
    '{"tool_calls":[{"name":"function_name","arguments":{}}]}',
    "Do not wrap the JSON in markdown.",
  ].join("\n");
}

/** Build the CLI prompt, avoiding replay of old turns when resuming a native session. */
export function requestToPrompt(req: NormalizedChatRequest): string {
  const messages = req.nativeSessionId ? trailingMessages(req.messages) : req.messages;
  const prompt = messagesToPrompt(messages.length ? messages : req.messages);
  const tools = toolInstructions(req.tools, req.toolChoice);
  return tools ? `${prompt}\n\n${tools}` : prompt;
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
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((tool): tool is ChatTool =>
        tool?.type === "function" &&
        Boolean(tool.function) &&
        typeof tool.function.name === "string" &&
        tool.function.name.length > 0,
      )
    : [];
  return {
    model: body.model,
    modelLocal,
    messages: body.messages,
    stream: Boolean(body.stream),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    raw: body,
    tools,
    toolChoice: body.tool_choice,
    sessionId: typeof body.session_id === "string" && body.session_id ? body.session_id : undefined,
  };
}

export function completionId(): string {
  return `chatcmpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function buildCompletionResponse(opts: {
  id: string;
  model: string;
  content: string;
  finishReason?: "stop" | "length" | "tool_calls" | "error";
  usage?: ChatCompletionResponse["usage"];
  toolCalls?: ToolCall[];
}): ChatCompletionResponse {
  return {
    id: opts.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.toolCalls?.length ? null : opts.content,
          ...(opts.toolCalls?.length ? { tool_calls: opts.toolCalls } : {}),
        },
        finish_reason: opts.finishReason ?? "stop",
      },
    ],
    usage: opts.usage,
  };
}

export function buildChunk(opts: {
  id: string;
  model: string;
  delta?: {
    role?: "assistant";
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
  finishReason?: "stop" | "length" | "tool_calls" | "error" | null;
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
