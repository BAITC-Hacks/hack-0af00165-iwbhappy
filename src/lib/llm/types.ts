/**
 * Провайдеро-независимые типы. Агентный цикл знает только их —
 * благодаря этому OpenAI можно заменить на NVIDIA NIM или на mock,
 * не трогая ни одной строчки в agent/loop.ts.
 */

export type ToolCall = { id: string; name: string; arguments: string };

export type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
};

export type ModelTurn = {
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  source: "live" | "mock";
  usage?: { prompt: number; completion: number };
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
