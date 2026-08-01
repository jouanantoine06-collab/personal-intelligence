// Premier outil de démonstration (V1.1) : notes internes. Volontairement trivial —
// son seul but est de faire fonctionner la chaîne complète Orchestrateur → Permission
// Gate → Tool Registry → Tool Executor → Résultat → Audit Journal.
//
// Deux outils, pas un seul, pour prouver les deux branches du Permission Gate :
// - list_internal_notes : lecture, "no_risk", jamais de confirmation.
// - create_internal_note : écriture, "reversible", nécessite toujours confirmation
//   (au moins une fois) — délibérément, pour que cette tranche démontre réellement
//   le cycle une fois / session / toujours, ce qu'un outil purement "no_risk" ne
//   permettrait pas de prouver.

import { z } from "zod";
import { registerTool, type ToolDefinition } from "@/core/tool-registry/index";

const listNotesInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

const listInternalNotesTool: ToolDefinition<
  z.infer<typeof listNotesInputSchema>,
  { notes: { id: string; content: string; createdAt: string }[] }
> = {
  name: "list_internal_notes",
  description: "Liste les notes internes déjà enregistrées par l'utilisateur, les plus récentes en premier.",
  riskLevel: "no_risk",
  requiredPermission: "list_internal_notes",
  aiInputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Nombre maximum de notes à retourner (défaut 20)." },
    },
    additionalProperties: false,
  },
  parseInput: (raw) => listNotesInputSchema.parse(raw),
  async execute(input, { supabase, userId }) {
    const { data, error } = await supabase
      .from("internal_notes")
      .select("id, content, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(input.limit ?? 20);

    if (error) {
      throw new Error(`Lecture des notes internes impossible: ${error.message}`);
    }

    return {
      notes: (data ?? []).map((row) => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
      })),
    };
  },
};

const createNoteInputSchema = z.object({
  content: z.string().min(1).max(2000),
});

const createInternalNoteTool: ToolDefinition<
  z.infer<typeof createNoteInputSchema>,
  { id: string; content: string; createdAt: string }
> = {
  name: "create_internal_note",
  description: "Enregistre une nouvelle note interne pour l'utilisateur.",
  riskLevel: "reversible",
  requiredPermission: "create_internal_note",
  aiInputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "Le contenu de la note à enregistrer." },
    },
    required: ["content"],
    additionalProperties: false,
  },
  parseInput: (raw) => createNoteInputSchema.parse(raw),
  async execute(input, { supabase, userId }) {
    const { data, error } = await supabase
      .from("internal_notes")
      .insert({ user_id: userId, content: input.content })
      .select("id, content, created_at")
      .single();

    if (error || !data) {
      throw new Error(`Écriture de la note interne impossible: ${error?.message}`);
    }

    return { id: data.id, content: data.content, createdAt: data.created_at };
  },
};

export function registerBuiltinTools(): void {
  registerTool(listInternalNotesTool as ToolDefinition);
  registerTool(createInternalNoteTool as ToolDefinition);
}
