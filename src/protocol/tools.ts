import type { ChatEvent, NormalizedChatRequest, ToolCall } from "../types.js";
import { Ajv } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next extraction.
    }
  }
  return null;
}

function callFromUnknown(value: unknown, req: NormalizedChatRequest): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const nested = raw.function && typeof raw.function === "object"
    ? raw.function as Record<string, unknown>
    : raw;
  const name = typeof nested.name === "string"
    ? nested.name
    : typeof raw.tool === "string"
      ? raw.tool
      : "";
  const definition = req.tools.find((tool) => tool.function.name === name)?.function;
  if (!name || !definition) return null;
  const args = nested.arguments ?? raw.arguments ?? {};
  let argumentsJson: string;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      argumentsJson = args;
    } catch {
      return null;
    }
  } else {
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    argumentsJson = JSON.stringify(args ?? {});
  }
  if (definition.strict) {
    try {
      const validate = ajv.compile(definition.parameters ?? { type: "object" });
      if (!validate(JSON.parse(argumentsJson))) return null;
    } catch {
      // Invalid schemas are rejected at the tool-call boundary as well.
      return null;
    }
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name, arguments: argumentsJson },
  };
}

export function parseToolCalls(text: string, req: NormalizedChatRequest): ToolCall[] {
  const object = parseJsonObject(text);
  if (!object) return [];
  const rawCalls = Array.isArray(object.tool_calls)
    ? object.tool_calls
    : object.tool || object.name
      ? [object]
      : [];
  return rawCalls
    .map((value) => callFromUnknown(value, req))
    .filter((value): value is ToolCall => Boolean(value));
}

/**
 * Tool-capable requests buffer assistant content so a JSON call envelope never
 * leaks as normal text. Reasoning and session events remain live.
 */
export async function* transformToolEvents(
  events: AsyncIterable<ChatEvent>,
  req: NormalizedChatRequest,
): AsyncIterable<ChatEvent> {
  if (!req.tools.length || req.toolChoice === "none") {
    yield* events;
    return;
  }

  let content = "";
  let done: Extract<ChatEvent, { type: "done" }> | undefined;
  let nativeCalls = false;
  let invalidNativeCalls = false;
  for await (const event of events) {
    if (event.type === "delta" && (event.channel ?? "content") === "content") {
      content += event.text;
    } else if (event.type === "done") {
      done = event;
    } else if (event.type === "tool_call") {
      const validated = callFromUnknown(event.call, req);
      if (validated) {
        nativeCalls = true;
        yield { type: "tool_call", call: validated };
      } else {
        invalidNativeCalls = true;
      }
    } else {
      yield event;
    }
  }

  if (nativeCalls) {
    yield { ...(done ?? { type: "done", finishReason: "tool_calls" }), finishReason: "tool_calls" };
    return;
  }
  if (invalidNativeCalls) {
    yield { type: "error", message: "Adapter returned a tool call that failed function or strict schema validation", code: "invalid_tool_call" };
    return;
  }

  const calls = parseToolCalls(content, req);
  if (calls.length) {
    for (const call of calls) yield { type: "tool_call", call };
    yield { type: "done", finishReason: "tool_calls", usage: done?.usage };
    return;
  }

  if (req.toolChoice === "required" || typeof req.toolChoice === "object") {
    yield { type: "error", message: "Model did not return a valid required tool call", code: "tool_call_expected" };
    return;
  }
  if (content) yield { type: "delta", text: content, channel: "content" };
  yield done ?? { type: "done", finishReason: "stop" };
}
