import type { ChatCompletionRequest, ChatMessage, ChatTool, ToolCall } from "../types.js";

export interface ResponsesRequest {
  model: string;
  input: string | Array<Record<string, unknown>>;
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
  for (const raw of input) {
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
  const messages = inputToMessages(body.input);
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
  const choice = typeof body.tool_choice === "object"
    ? { type: "function" as const, function: { name: body.tool_choice.name } }
    : body.tool_choice;
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
