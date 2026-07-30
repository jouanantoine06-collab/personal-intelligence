import Anthropic from "@anthropic-ai/sdk";
import type {
  AICompletionRequest,
  AICompletionResult,
  AIContentBlock,
  AIMessage,
  AIProvider,
  AIToolCall,
  ModelTier,
} from "@/core/ai-provider/types";

const MODEL_BY_TIER: Record<ModelTier, string> = {
  reasoning: "claude-sonnet-5",
  fast: "claude-haiku-4-5-20251001",
};

const MAX_TOKENS = 2048;

type AnthropicContentBlockParam = Anthropic.MessageParam["content"] extends
  | string
  | Array<infer Block>
  ? Block
  : never;

function toAnthropicContent(content: AIContentBlock[]): AnthropicContentBlockParam[] {
  return content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
        };
    }
  });
}

function toAnthropicMessages(messages: AIMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: toAnthropicContent(message.content),
  }));
}

function fromAnthropicContent(
  content: Anthropic.ContentBlock[],
): { blocks: AIContentBlock[]; toolCalls: AIToolCall[]; textSummary: string | null } {
  const blocks: AIContentBlock[] = [];
  const toolCalls: AIToolCall[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const toolCall: AIToolCall = {
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
      blocks.push({ type: "tool_use", ...toolCall });
      toolCalls.push(toolCall);
    }
  }

  return {
    blocks,
    toolCalls,
    textSummary: textParts.length > 0 ? textParts.join("\n") : null,
  };
}

export class AnthropicProvider implements AIProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResult> {
    const tools: Anthropic.Tool[] | undefined = request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model: MODEL_BY_TIER[request.tier],
      max_tokens: MAX_TOKENS,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      ...(tools ? { tools } : {}),
    });

    const { blocks, toolCalls, textSummary } = fromAnthropicContent(response.content);

    return { content: blocks, toolCalls, textSummary };
  }
}

let singleton: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (!singleton) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY manquant.");
    }
    singleton = new AnthropicProvider(apiKey);
  }
  return singleton;
}
