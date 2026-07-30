// AI Provider — adaptateur pur (ADR-0007). Types neutres, indépendants du fournisseur :
// l'Orchestrateur et le Memory Engine ne manipulent jamais de type spécifique à Anthropic.

export type ModelTier = "reasoning" | "fast";

export type AIContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string };

export interface AIMessage {
  role: "user" | "assistant";
  content: AIContentBlock[];
}

export interface AIToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AICompletionRequest {
  tier: ModelTier;
  system: string;
  messages: AIMessage[];
  tools?: AIToolDefinition[];
}

export interface AIToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AICompletionResult {
  content: AIContentBlock[];
  textSummary: string | null;
  toolCalls: AIToolCall[];
}

export interface AIProvider {
  complete(request: AICompletionRequest): Promise<AICompletionResult>;
}

export function userText(text: string): AIMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function assistantText(text: string): AIMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}
