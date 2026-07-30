import { z } from "zod";

// Un schéma par type de mémoire pour `structured_content` (docs/architecture/memory-system.md).
// Volontairement minimal en V0.1 : juste assez de structure pour être exploitable,
// pas une modélisation exhaustive anticipée sans besoin réel.

export const memoryTypeSchema = z.enum([
  "profil",
  "projet",
  "relationnel",
  "episodique",
  "temporaire",
  "regles",
]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

const profilSchema = z.object({ key: z.string().min(1), value: z.string().min(1) });
const projetSchema = z.object({
  project_name: z.string().min(1),
  statut: z.enum(["actif", "en_pause", "termine"]).default("actif"),
  details: z.string().optional(),
});
const relationnelSchema = z.object({
  person_name: z.string().min(1),
  relation: z.string().optional(),
  details: z.string().optional(),
});
const episodiqueSchema = z.object({ event: z.string().min(1), when: z.string().optional() });
const temporaireSchema = z.object({ note: z.string().min(1) });
const reglesSchema = z.object({ rule: z.string().min(1) });

const structuredContentSchemaByType: Record<MemoryType, z.ZodTypeAny> = {
  profil: profilSchema,
  projet: projetSchema,
  relationnel: relationnelSchema,
  episodique: episodiqueSchema,
  temporaire: temporaireSchema,
  regles: reglesSchema,
};

export function parseStructuredContent(
  type: MemoryType,
  structuredContent: unknown,
): Record<string, unknown> {
  return structuredContentSchemaByType[type].parse(structuredContent) as Record<
    string,
    unknown
  >;
}

// Candidat produit par l'étape d'extraction (appel modèle "fast") à partir d'une
// déclaration brute signalée par le modèle de raisonnement.

export const memoryCandidateSchema = z.object({
  type: memoryTypeSchema,
  content: z.string().min(1),
  structured_content: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  sensitivity: z.enum(["public", "normal", "sensible"]),
  event_date: z.string().datetime().nullable(),
  is_explicit_request: z.boolean(),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;

// Schéma JSON (pour le tool Anthropic) de l'outil `flag_memory_candidate`, utilisé
// par le modèle de raisonnement pour signaler une information potentiellement à retenir.

export const flagMemoryCandidateToolInputSchema = {
  type: "object",
  properties: {
    raw_statement: {
      type: "string",
      description:
        "La déclaration brute de l'utilisateur qui semble digne d'être mémorisée, reformulée clairement.",
    },
    is_explicit_request: {
      type: "boolean",
      description:
        "true si l'utilisateur a explicitement demandé de retenir cette information (ex. 'souviens-toi que'), false si c'est une simple observation.",
    },
  },
  required: ["raw_statement", "is_explicit_request"],
  additionalProperties: false,
} as const;
