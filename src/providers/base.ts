// ── Tool definitions ─────────────────────────────────────────────────────────

export type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

// ── Provider messages ────────────────────────────────────────────────────────

export type TextContent   = { type: 'text';   text: string };
export type ImageContent  = { type: 'image';  mimeType: string; data: string };
export type ToolUseContent = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultContent = {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type SystemMessage = {
  role: 'system';
  content: string;
};

export type UserMessage = {
  role: 'user';
  content: Array<TextContent | ImageContent | ToolResultContent>;
};

export type AssistantMessage = {
  role: 'assistant';
  content: Array<TextContent | ToolUseContent>;
};

export type ProviderMessage = SystemMessage | UserMessage | AssistantMessage;

// ── Stream chunks ────────────────────────────────────────────────────────────

export type TextDeltaChunk = {
  type: 'text_delta';
  delta: string;
};

export type ToolUseStartChunk = {
  type: 'tool_use_start';
  id: string;
  name: string;
};

export type ToolInputDeltaChunk = {
  type: 'tool_input_delta';
  id: string;
  delta: string;
};

export type ToolUseEndChunk = {
  type: 'tool_use_end';
  id: string;
};

export type MessageStopChunk = {
  type: 'message_stop';
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'cancelled';
};

export type UsageChunk = {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
};

export type StreamChunk =
  | TextDeltaChunk
  | ToolUseStartChunk
  | ToolInputDeltaChunk
  | ToolUseEndChunk
  | MessageStopChunk
  | UsageChunk;

// ── Model info ───────────────────────────────────────────────────────────────

export type ModelInfo = {
  id: string;
  name: string;
  providerID: string;
  contextWindow?: number;
};

// ── Provider interface ───────────────────────────────────────────────────────

export interface IProvider {
  readonly providerID: string;

  streamCompletion(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk>;

  listModels(): Promise<ModelInfo[]>;
}

// ── Error class ──────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly providerID?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
