import { z } from "zod";
import type { AIProvider } from "@/core/ai-provider/types";
import { userText } from "@/core/ai-provider/types";
import { parseJsonResponse } from "@/core/ai-provider/parse-json-response";

const resolutionSchema = z.object({
  outcome: z.enum(["confirm", "reject", "unrelated"]),
});

const SYSTEM_PROMPT = `Une proposition de mémorisation est en attente de confirmation par l'utilisateur.
Détermine si son dernier message confirme cette proposition, la refuse, ou parle d'autre chose (message sans rapport).
Réponds UNIQUEMENT avec un JSON de la forme {"outcome": "confirm" | "reject" | "unrelated"}, sans balise markdown.`;

export type ConfirmationOutcome = "confirm" | "reject" | "unrelated";

export async function resolvePendingConfirmation(
  aiProvider: AIProvider,
  params: { pendingContent: string; userMessage: string },
): Promise<ConfirmationOutcome> {
  const result = await aiProvider.complete({
    tier: "fast",
    system: SYSTEM_PROMPT,
    messages: [
      userText(
        `Proposition en attente : "${params.pendingContent}"\nMessage de l'utilisateur : "${params.userMessage}"`,
      ),
    ],
  });

  if (!result.textSummary) {
    return "unrelated";
  }

  try {
    const parsed: unknown = parseJsonResponse(result.textSummary);
    return resolutionSchema.parse(parsed).outcome;
  } catch {
    return "unrelated";
  }
}
