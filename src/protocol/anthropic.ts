import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatTool,
  ContentPart,
  ToolCall,
} from "../types.js";

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
  [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }>;
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    strict?: boolean;
  }>;
  tool_choice?:
    | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
    | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
  thinking?: { type?: "enabled" | "disabled"; budget_tokens?: number };
  metadata?: { user_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function blocksToText(blocks: AnthropicContentBlock[]): string {
  return blocks.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (block.type === "thinking" && typeof block.thinking === "string") return [block.thinking];
    return [];
  }).join("\n");
}

function imagePart(block: AnthropicContentBlock): ContentPart | undefined {
  if (block.type !== "image" || !block.source || typeof block.source !== "object") return undefined;
  if (block.source.type === "base64" && block.source.media_type && block.source.data) {
    return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  }
  if (block.source.type === "url" && block.source.url) {
    return { type: "image_url", image_url: { url: block.source.url } };
  }
  return undefined;
}

/** Translate Anthropic Messages input into the gateway's normalized Chat shape. */
export function anthropicToChat(body: AnthropicMessagesRequest): ChatCompletionRequest {
  if (!body || typeof body !== "object") invalid("Request body must be a JSON object");
  if (!body.model || typeof body.model !== "string") invalid("`model` is required");
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) invalid("`max_tokens` must be a positive integer");
  if (!Array.isArray(body.messages) || body.messages.length === 0) invalid("`messages` must be a non-empty array");
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("`stream` must be a boolean");
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 1)) {
    invalid("`temperature` must be between 0 and 1");
  }

  const messages: ChatMessage[] = [];
  if (body.system !== undefined) {
    if (typeof body.system === "string") messages.push({ role: "developer", content: body.system });
    else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
          invalid("`system` content blocks must contain text");
        }
        // Keep block ordering instead of collapsing attribution/cache-marked
        // system content into a single string.
        messages.push({ role: "developer", content: block.text });
      }
    }
    else invalid("`system` must be a string or content block array");
  }

  body.messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object" || (message.role !== "user" && message.role !== "assistant")) {
      invalid(`messages[${messageIndex}] must have role user or assistant`);
    }
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      return;
    }
    if (!Array.isArray(message.content)) invalid(`messages[${messageIndex}].content must be a string or array`);
    const blocks = message.content;
    if (blocks.some((block) => !block || typeof block !== "object" || typeof block.type !== "string")) {
      invalid(`messages[${messageIndex}].content contains an invalid block`);
    }

    if (message.role === "assistant") {
      const content: ContentPart[] = [];
      const toolCalls: ToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
        const image = imagePart(block);
        if (image) content.push(image);
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      messages.push({ role: "assistant", content: content.length ? content : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      return;
    }

    const userContent: ContentPart[] = [];
    const toolResults: AnthropicContentBlock[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") userContent.push({ type: "text", text: block.text });
      const image = imagePart(block);
      if (image) userContent.push(image);
      if (block.type === "tool_result") toolResults.push(block);
    }
    // Anthropic requires tool_result blocks before ordinary user content.
    for (const block of toolResults) {
      if (typeof block.tool_use_id !== "string") invalid(`messages[${messageIndex}] tool_result requires tool_use_id`);
      const content = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content) ? blocksToText(block.content) : "";
      messages.push({ role: "tool", tool_call_id: block.tool_use_id, content });
    }
    if (userContent.length) messages.push({ role: "user", content: userContent });
    if (!userContent.length && !toolResults.length) messages.push({ role: "user", content: "" });
  });

  let toolChoice: ChatCompletionRequest["tool_choice"];
  if (body.tool_choice?.type === "any") toolChoice = "required";
  else if (body.tool_choice?.type === "none") toolChoice = "none";
  else if (body.tool_choice?.type === "tool") {
    if (!body.tool_choice.name) invalid("`tool_choice.name` is required for type tool");
    toolChoice = { type: "function", function: { name: body.tool_choice.name } };
  } else if (body.tool_choice) toolChoice = "auto";

  if (body.tools !== undefined && !Array.isArray(body.tools)) invalid("`tools` must be an array");
  const tools: ChatTool[] = (body.tools ?? []).map((tool, index) => {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name.trim()) {
      invalid(`tools[${index}].name is required`);
    }
    if (tool.input_schema !== undefined && (!tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema))) {
      invalid(`tools[${index}].input_schema must be a JSON Schema object`);
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object" },
        strict: tool.strict,
      },
    };
  });

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools,
    tool_choice: toolChoice,
    include_reasoning: body.thinking?.type === "enabled",
    reasoning: body.thinking?.type === "enabled"
      ? { enabled: true, max_tokens: body.thinking.budget_tokens }
      : undefined,
    user: body.metadata?.user_id,
  };
}

export function anthropicMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function anthropicUsage(usage?: ChatCompletionResponse["usage"]): {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
} {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: usage?.completion_tokens ?? 0,
  };
}

export function anthropicStopReason(
  finishReason: "stop" | "length" | "tool_calls" | "error" | null | undefined,
): "end_turn" | "max_tokens" | "tool_use" | null {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop") return "end_turn";
  return null;
}

export function buildAnthropicMessage(opts: {
  id: string;
  model: string;
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: "stop" | "length" | "tool_calls" | "error";
  usage?: ChatCompletionResponse["usage"];
}) {
  const content: Array<Record<string, unknown>> = [];
  if (opts.reasoning) content.push({ type: "thinking", thinking: opts.reasoning, signature: "cli2api" });
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const call of opts.toolCalls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: opts.id,
    type: "message" as const,
    role: "assistant" as const,
    model: opts.model,
    content,
    stop_reason: anthropicStopReason(opts.finishReason ?? "stop"),
    stop_sequence: null,
    usage: anthropicUsage(opts.usage),
  };
}

export function anthropicError(message: string, type = "api_error") {
  return { type: "error" as const, error: { type, message } };
}
