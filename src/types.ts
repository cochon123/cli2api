/** Shared types for cli2api. */

export type Role = "system" | "user" | "assistant" | "tool" | "developer";

export interface ChatMessage {
  role: Role | string;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatTool {
  type: "function";
  function: FunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: string; [key: string]: unknown };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  user?: string;
  tools?: ChatTool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  /** cli2api extension: stable gateway session key for native CLI resume. */
  session_id?: string;
  /** Pass-through / debug */
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "error" | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      /** OpenRouter-style reasoning stream */
      reasoning?: string;
      /** Alternate field some OpenAI-compatible clients expect */
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "error" | null;
  }>;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Adapter-specific notes */
  description?: string;
}

export interface NormalizedChatRequest {
  model: string;
  /** Model id without adapter prefix */
  modelLocal: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  raw: ChatCompletionRequest;
  tools: ChatTool[];
  toolChoice?: ChatCompletionRequest["tool_choice"];
  sessionId?: string;
  /** Native CLI session id, populated by the gateway session store. */
  nativeSessionId?: string;
}

export type DeltaChannel = "content" | "reasoning";

export type ChatEvent =
  | { type: "delta"; text: string; channel?: DeltaChannel }
  | { type: "tool_call"; call: ToolCall }
  | { type: "session"; id: string }
  | { type: "done"; finishReason: "stop" | "length" | "tool_calls" | "error"; usage?: ChatCompletionResponse["usage"] }
  | { type: "error"; message: string; code?: string };

export interface HealthStatus {
  ok: boolean;
  adapter: string;
  details: Record<string, unknown>;
  message?: string;
}

export interface DoctorReport {
  adapter: string;
  ok: boolean;
  binary?: string;
  version?: string;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}
