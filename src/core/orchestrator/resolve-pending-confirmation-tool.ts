// Résolution des confirmations d'outil par le modèle principal (V1.2), qui dispose
// du contexte complet de la conversation — remplace l'ancien classifieur isolé
// (supprimé) qui ne voyait que le contenu en attente + le dernier message.
//
// Le modèle ne possède toujours pas l'autorité finale : sa sortie est validée par
// un schéma strict, doit désigner explicitement QUELLE confirmation elle résout
// (jamais par position), et ne peut jamais transporter de contenu de remplacement
// pour l'action — seul le payload figé au moment de la demande initiale est utilisé
// à l'exécution (garanti par le code de l'orchestrateur, pas par ce schéma).

import { z } from "zod";
import type { AIToolDefinition } from "@/core/ai-provider/types";

export const RESOLVE_PENDING_CONFIRMATION_TOOL_NAME = "resolve_pending_confirmation";

const baseFields = {
  confirmationId: z
    .string()
    .describe("L'identifiant exact de la confirmation en attente que cette décision résout."),
};

// .strict() sur chaque variante : un champ additionnel (ex. une tentative de fournir
// un contenu de remplacement) invalide toute la sortie plutôt que d'être ignoré
// silencieusement.
export const resolvePendingConfirmationSchema = z.discriminatedUnion("decision", [
  z.object({ ...baseFields, decision: z.literal("confirm"), scope: z.enum(["once", "session", "always"]) }).strict(),
  z.object({ ...baseFields, decision: z.literal("reject") }).strict(),
  z.object({ ...baseFields, decision: z.literal("unrelated") }).strict(),
  z.object({ ...baseFields, decision: z.literal("clarify") }).strict(),
]);

export type ResolvePendingConfirmationDecision = z.infer<typeof resolvePendingConfirmationSchema>;

// Parsing tolérant : ne lève jamais — une sortie ambiguë/invalide doit être
// traitée comme "aucune décision exploitable", jamais comme une exception qui
// ferait échouer tout le tour.
export function parseResolvePendingConfirmationInput(
  raw: unknown,
): ResolvePendingConfirmationDecision | null {
  const result = resolvePendingConfirmationSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function buildResolvePendingConfirmationTool(
  eligibleIds: string[],
): AIToolDefinition {
  return {
    name: RESOLVE_PENDING_CONFIRMATION_TOOL_NAME,
    description:
      "Résout une confirmation d'action en attente. À utiliser UNIQUEMENT pour répondre à une demande d'autorisation déjà posée à l'utilisateur — jamais pour proposer une nouvelle action.",
    inputSchema: {
      type: "object",
      properties: {
        confirmationId: {
          type: "string",
          enum: eligibleIds,
          description: "Identifiant de la confirmation en attente concernée.",
        },
        decision: {
          type: "string",
          enum: ["confirm", "reject", "unrelated", "clarify"],
          description:
            "'confirm' si l'utilisateur autorise l'action, 'reject' s'il la refuse, 'unrelated' si son message ne répond pas à cette demande, 'clarify' si sa réponse est ambiguë.",
        },
        scope: {
          type: "string",
          enum: ["once", "session", "always"],
          description:
            "Requis UNIQUEMENT si decision='confirm' : une seule fois, pour cette session, ou pour toujours. Ne jamais deviner — utiliser 'clarify' si l'utilisateur n'a pas précisé.",
        },
      },
      required: ["confirmationId", "decision"],
      additionalProperties: false,
    },
  };
}
