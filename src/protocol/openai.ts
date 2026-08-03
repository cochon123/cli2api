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
import { Ajv } from "ajv";

const schemaCompiler = new Ajv({ strict: false });

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
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (!body || typeof body !== "object") {
    invalid("Request body must be a JSON object");
  }
  if (!body.model || typeof body.model !== "string") {
    invalid("`model` is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    invalid("`messages` must be a non-empty array");
  }
  const validRoles = new Set(["system", "developer", "user", "assistant", "tool"]);
  for (let index = 0; index < body.messages.length; index += 1) {
    const rawMessage = body.messages[index] as unknown;
    if (!rawMessage || typeof rawMessage !== "object") invalid(`messages[${index}] must be an object`);
    const message = rawMessage as ChatMessage;
    if (!validRoles.has(message.role)) {
      invalid(`messages[${index}] must have a supported role`);
    }
    if (message.content !== null && typeof message.content !== "string" && !Array.isArray(message.content)) {
      invalid(`messages[${index}].content must be a string, array, or null`);
    }
    if (Array.isArray(message.content) && message.content.some((part) => !part || typeof part !== "object" || typeof part.type !== "string")) {
      invalid(`messages[${index}].content contains an invalid content part`);
    }
    if (message.role === "tool" && (!message.tool_call_id || typeof message.tool_call_id !== "string")) {
      invalid(`messages[${index}].tool_call_id is required for tool messages`);
    }
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("`stream` must be a boolean");
  if (body.stream_options !== undefined) {
    if (!body.stream_options || typeof body.stream_options !== "object" || Array.isArray(body.stream_options)) {
      invalid("`stream_options` must be an object");
    }
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== "boolean") {
      invalid("`stream_options.include_usage` must be a boolean");
    }
  }
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    invalid("`temperature` must be between 0 and 2");
  }
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
    invalid("`max_tokens` must be a positive integer");
  }
  if (body.max_completion_tokens !== undefined && (!Number.isInteger(body.max_completion_tokens) || body.max_completion_tokens < 1)) {
    invalid("`max_completion_tokens` must be a positive integer");
  }
  if (body.include_reasoning !== undefined && typeof body.include_reasoning !== "boolean") {
    invalid("`include_reasoning` must be a boolean");
  }
  if (body.reasoning !== undefined && (!body.reasoning || typeof body.reasoning !== "object" || Array.isArray(body.reasoning))) {
    invalid("`reasoning` must be an object");
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) invalid("`tools` must be an array");
  const tools = body.tools ?? [];
  for (let index = 0; index < tools.length; index += 1) {
    const rawTool = tools[index] as unknown;
    if (!rawTool || typeof rawTool !== "object") invalid(`tools[${index}] must be an object`);
    const tool = rawTool as ChatTool;
    if (tool.type !== "function" || !tool.function || typeof tool.function !== "object") {
      invalid(`tools[${index}] must be a function tool`);
    }
    if (typeof tool.function.name !== "string" || !tool.function.name.trim()) invalid(`tools[${index}].function.name is required`);
    if (tool.function.parameters !== undefined && (!tool.function.parameters || typeof tool.function.parameters !== "object" || Array.isArray(tool.function.parameters))) {
      invalid(`tools[${index}].function.parameters must be a JSON Schema object`);
    }
    if (tool.function.strict !== undefined && typeof tool.function.strict !== "boolean") invalid(`tools[${index}].function.strict must be a boolean`);
    if (tool.function.strict) {
      try {
        schemaCompiler.compile(tool.function.parameters ?? { type: "object" });
      } catch (error) {
        invalid(`tools[${index}].function.parameters is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const choice = body.tool_choice;
  if (choice !== undefined && choice !== "none" && choice !== "auto" && choice !== "required") {
    if (!choice || typeof choice !== "object" || choice.type !== "function" || !choice.function || typeof choice.function.name !== "string" || !choice.function.name) {
      invalid("`tool_choice` must be none, auto, required, or a named function choice");
    }
    if (!tools.some((tool) => tool.function.name === choice.function.name)) {
      invalid(`tool_choice references undeclared function: ${choice.function.name}`);
    }
  }
  if ((choice === "required" || (typeof choice === "object" && choice)) && tools.length === 0) {
    invalid("`tool_choice` requires at least one valid function tool");
  }

  const { modelLocal } = parseModelId(body.model);
  return {
    model: body.model,
    modelLocal,
    messages: body.messages,
    stream: Boolean(body.stream),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    maxTokens: typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    raw: body,
    tools,
    toolChoice: body.tool_choice,
    sessionId: typeof body.session_id === "string" && body.session_id ? body.session_id : undefined,
  };
}

export function completionId(prefix = "chatcmpl"): string {
  const separator = prefix === "chatcmpl" ? "_" : "-";
  return `${prefix}${separator}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function buildCompletionResponse(opts: {
  id: string;
  model: string;
  content: string;
  finishReason?: "stop" | "length" | "tool_calls" | "error";
  usage?: ChatCompletionResponse["usage"];
  toolCalls?: ToolCall[];
  reasoning?: string;
  openRouter?: boolean;
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
          ...(opts.reasoning ? { reasoning: opts.reasoning, reasoning_content: opts.reasoning } : {}),
          ...(opts.toolCalls?.length ? { tool_calls: opts.toolCalls } : {}),
        },
        finish_reason: opts.finishReason ?? "stop",
        ...(opts.openRouter ? { native_finish_reason: opts.finishReason ?? "stop" } : {}),
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
  usage?: ChatCompletionResponse["usage"];
  openRouter?: boolean;
  emptyChoices?: boolean;
}): ChatCompletionChunk {
  return {
    id: opts.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: opts.emptyChoices ? [] : [
      {
        index: 0,
        delta: opts.delta ?? {},
        finish_reason: opts.finishReason ?? null,
        ...(opts.openRouter ? { native_finish_reason: opts.finishReason ?? null } : {}),
      },
    ],
    ...(opts.usage ? { usage: opts.usage } : {}),
  };
}

export function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
