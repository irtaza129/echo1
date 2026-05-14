export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  response: unknown;
}

export interface TranscriptTurn {
  index: number;
  customerText: string | null;
  aiText: string | null;
  toolCalls: ToolCallRecord[];
  promptTokens: number;
  responseTokens: number;
  costUsd: number;
  timestamp: string; // ISO-8601
}
