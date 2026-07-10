import type { ChatCompletionRequest, ChatMessage, ChatTool, ToolCall } from "../types.js";

export interface ResponsesRequest {
  model: string;
  input: string | Array<Record<string, unknown>>;
  instructions?: string | null;
  stream?: boolean;
  tools?: Array<{ type: "function"; name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }>;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; name: string };
  previous_response_id?: string;
  temperature?: number;
  max_output_tokens?: number;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    return typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function inputToMessages(input: ResponsesRequest["input"]): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const messages: ChatMessage[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`input[${index}] must be an object`);
    if (raw.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: String(raw.call_id ?? ""), content: contentText(raw.output) });
    } else if (raw.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: String(raw.call_id ?? raw.id ?? ""),
          type: "function",
          function: { name: String(raw.name ?? ""), arguments: String(raw.arguments ?? "{}") },
        }],
      });
    } else if (typeof raw.role === "string") {
      messages.push({ role: raw.role, content: contentText(raw.content) });
    }
  }
  return messages;
}

export function responsesToChat(body: ResponsesRequest): ChatCompletionRequest {
  if (!body || typeof body !== "object") throw new Error("Request body must be a JSON object");
  if (!body.model || typeof body.model !== "string") throw new Error("`model` is required");
  if (typeof body.input !== "string" && !Array.isArray(body.input)) throw new Error("`input` is required");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new Error("`stream` must be a boolean");
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error("`temperature` must be between 0 and 2");
  if (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1)) throw new Error("`max_output_tokens` must be a positive integer");
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new Error("`tools` must be an array");
  for (let index = 0; index < (body.tools?.length ?? 0); index += 1) {
    const tool = body.tools![index];
    if (!tool || typeof tool !== "object" || tool.type !== "function" || typeof tool.name !== "string" || !tool.name.trim()) {
      throw new Error(`tools[${index}] must be a named function tool`);
    }
    if (tool.parameters !== undefined && (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) {
      throw new Error(`tools[${index}].parameters must be a JSON Schema object`);
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") throw new Error(`tools[${index}].strict must be a boolean`);
  }
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") {
    throw new Error("`instructions` must be a string or null");
  }
  const messages = inputToMessages(body.input);
  if (body.instructions) messages.unshift({ role: "developer", content: body.instructions });
  if (!messages.length) throw new Error("`input` must contain at least one supported input item");
  const tools: ChatTool[] = (body.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }));
  const rawChoice = body.tool_choice;
  if (rawChoice !== undefined && rawChoice !== "none" && rawChoice !== "auto" && rawChoice !== "required") {
    if (!rawChoice || typeof rawChoice !== "object" || rawChoice.type !== "function" || typeof rawChoice.name !== "string" || !rawChoice.name) {
      throw new Error("`tool_choice` must be none, auto, required, or a named function choice");
    }
    if (!tools.some((tool) => tool.function.name === rawChoice.name)) throw new Error(`tool_choice references undeclared function: ${rawChoice.name}`);
  }
  if ((rawChoice === "required" || (typeof rawChoice === "object" && rawChoice)) && tools.length === 0) throw new Error("`tool_choice` requires at least one valid function tool");
  const choice = typeof rawChoice === "object"
    ? { type: "function" as const, function: { name: rawChoice.name } }
    : rawChoice;
  return {
    model: body.model,
    messages,
    stream: body.stream,
    tools,
    tool_choice: choice,
    session_id: body.previous_response_id,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens,
  };
}

export function responseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed";
  model: string;
  output: Array<Record<string, unknown>>;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  error: null | { message: string; code?: string };
  incomplete_details: null;
}

export function messageOutput(id: string, text: string): Record<string, unknown> {
  return {
    id, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function functionOutput(call: ToolCall): Record<string, unknown> {
  return {
    id: `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function_call",
    status: "completed",
    call_id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

export function buildResponse(opts: {
  id: string; model: string; text?: string; reasoning?: string; toolCalls?: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  status?: ResponseObject["status"]; error?: ResponseObject["error"];
}): ResponseObject {
  const output: Array<Record<string, unknown>> = [];
  if (opts.reasoning) output.push({ id: `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "reasoning", summary: [{ type: "summary_text", text: opts.reasoning }] });
  for (const call of opts.toolCalls ?? []) output.push(functionOutput(call));
  if (!(opts.toolCalls?.length)) output.push(messageOutput(`msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, opts.text ?? ""));
  return {
    id: opts.id, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: opts.status ?? "completed", model: opts.model, output,
    usage: opts.usage ? { input_tokens: opts.usage.prompt_tokens, output_tokens: opts.usage.completion_tokens, total_tokens: opts.usage.total_tokens } : undefined,
    error: opts.error ?? null, incomplete_details: null,
  };
}
