import { z } from "zod";
import type { AIProvider } from "@/core/ai-provider/types";
import { userText } from "@/core/ai-provider/types";
import { parseJsonResponse } from "@/core/ai-provider/parse-json-response";

const resolutionSchema = z.object({
  outcome: z.enum(["once", "session", "always", "deny", "unrelated"]),
});

const SYSTEM_PROMPT = `Une action outil est en attente d'autorisation par l'utilisateur.
Détermine si son dernier message autorise l'action une seule fois ("once"), pour cette
session/conversation ("session"), pour toujours ("always"), la refuse ("deny"), ou parle
d'autre chose sans rapport ("unrelated").
Réponds UNIQUEMENT avec un JSON de la forme {"outcome": "once" | "session" | "always" | "deny" | "unrelated"}, sans balise markdown.`;

export type ToolPermissionResolution = "once" | "session" | "always" | "deny" | "unrelated";

export async function resolveToolPermissionResponse(
  aiProvider: AIProvider,
  params: { toolName: string; userMessage: string },
): Promise<ToolPermissionResolution> {
  const result = await aiProvider.complete({
    tier: "fast",
    system: SYSTEM_PROMPT,
    messages: [
      userText(
        `Action en attente d'autorisation : outil "${params.toolName}"\nMessage de l'utilisateur : "${params.userMessage}"`,
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
