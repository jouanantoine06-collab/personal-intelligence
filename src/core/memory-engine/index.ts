// Memory Engine — décide ce qui devient un fait persisté, le stocke avec son cycle
// de vie, le restitue contextuellement (docs/architecture/memory-system.md).
// Écriture et lecture restent un seul composant (voir audit d'architecture) mais sont
// organisées ici en deux zones internes clairement séparées.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { AIProvider } from "@/core/ai-provider/types";
import { userText } from "@/core/ai-provider/types";
import {
  memoryCandidateSchema,
  parseStructuredContent,
  type MemoryCandidate,
} from "@/core/memory-engine/schemas";
import { rowToMemoryItem, type MemoryItem } from "@/core/memory-engine/types";
import type { MemoryRetriever, MemoryRetrievalQuery } from "@/core/memory-engine/retriever";
import { StructuredMemoryRetriever } from "@/core/memory-engine/structured-retriever";

export type { MemoryItem, MemoryRetrievalQuery };
export { rowToMemoryItem };

const defaultRetriever: MemoryRetriever = new StructuredMemoryRetriever();

// --- Extraction --------------------------------------------------------------
// Étape distincte de la détection : transforme une déclaration brute (signalée par
// le modèle de raisonnement) en candidat structuré, via un appel modèle "fast".

const EXTRACTION_SYSTEM_PROMPT = `Tu extrais une information à mémoriser depuis une déclaration utilisateur.
Réponds UNIQUEMENT avec un objet JSON valide, sans balise markdown, avec exactement ces champs :
{
  "type": "profil" | "projet" | "relationnel" | "episodique" | "temporaire" | "regles",
  "content": string (résumé court et lisible),
  "structured_content": object (forme dépend du type : profil={key,value}, projet={project_name,statut,details?}, relationnel={person_name,relation?,details?}, episodique={event,when?}, temporaire={note}, regles={rule}),
  "confidence": number entre 0 et 1,
  "importance": number entre 0 et 1,
  "sensitivity": "public" | "normal" | "sensible",
  "event_date": string ISO-8601 ou null
}`;

export async function extractCandidate(
  aiProvider: AIProvider,
  rawStatement: string,
  isExplicitRequest: boolean,
): Promise<MemoryCandidate | null> {
  const result = await aiProvider.complete({
    tier: "fast",
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [userText(rawStatement)],
  });

  if (!result.textSummary) {
    return null;
  }

  try {
    const parsedJson: unknown = JSON.parse(result.textSummary);
    const candidate = memoryCandidateSchema.parse({
      ...(parsedJson as Record<string, unknown>),
      is_explicit_request: isExplicitRequest,
    });
    parseStructuredContent(candidate.type, candidate.structured_content);
    return candidate;
  } catch {
    return null;
  }
}

// --- Moteur de décision d'écriture --------------------------------------------
// Déterministe, jamais laissé au LLM (principe d'architecture n°4). V0.1 : aucune
// catégorie n'est configurée en auto-stockage (ADR-0008) — le résultat est donc
// toujours "propose", mais la fonction reste un vrai point d'extension.

export type MemoryWriteDecision = "auto_store" | "propose" | "never_store";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature stable pour les futures politiques (V0.1 : toujours "propose")
export function classifyCandidate(candidate: MemoryCandidate): MemoryWriteDecision {
  return "propose";
}

// --- Détection de conflit ------------------------------------------------------
// Repère un souvenir actif existant portant sur la même "clé naturelle" (préférence
// ou projet) pour proposer une supersession plutôt qu'un doublon silencieux.

async function findConflict(
  supabase: SupabaseClient<Database>,
  userId: string,
  candidate: MemoryCandidate,
): Promise<MemoryItem | null> {
  if (candidate.type !== "profil" && candidate.type !== "projet") {
    return null;
  }

  const naturalKey =
    candidate.type === "profil"
      ? (candidate.structured_content.key as string | undefined)
      : (candidate.structured_content.project_name as string | undefined);

  if (!naturalKey) {
    return null;
  }

  const jsonPath = candidate.type === "profil" ? "key" : "project_name";

  const { data, error } = await supabase
    .from("memory_items")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("type", candidate.type)
    .eq(`structured_content->>${jsonPath}`, naturalKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Détection de conflit mémoire impossible: ${error.message}`);
  }

  return data ? rowToMemoryItem(data) : null;
}

// --- Écriture --------------------------------------------------------------

export async function proposeMemory(
  supabase: SupabaseClient<Database>,
  params: { userId: string; turnId: string; candidate: MemoryCandidate },
): Promise<{ memoryItem: MemoryItem; supersedes: MemoryItem | null }> {
  const { userId, turnId, candidate } = params;
  const conflict = await findConflict(supabase, userId, candidate);

  const { data, error } = await supabase
    .from("memory_items")
    .insert({
      user_id: userId,
      type: candidate.type,
      content: candidate.content,
      structured_content: candidate.structured_content,
      source_type: candidate.is_explicit_request ? "explicite" : "infere",
      source_turn_id: turnId,
      event_date: candidate.event_date,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sensitivity: candidate.sensitivity,
      status: "proposed",
      supersedes_id: conflict?.id ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Écriture du candidat mémoire impossible: ${error?.message}`);
  }

  return { memoryItem: rowToMemoryItem(data), supersedes: conflict };
}

export async function confirmMemory(
  supabase: SupabaseClient<Database>,
  memoryItemId: string,
): Promise<MemoryItem> {
  const { data: proposedRow, error: readError } = await supabase
    .from("memory_items")
    .select("*")
    .eq("id", memoryItemId)
    .single();

  if (readError || !proposedRow) {
    throw new Error(`Souvenir proposé introuvable: ${readError?.message}`);
  }

  if (proposedRow.supersedes_id) {
    const { error: supersedeError } = await supabase
      .from("memory_items")
      .update({ status: "superseded" })
      .eq("id", proposedRow.supersedes_id);

    if (supersedeError) {
      throw new Error(`Supersession impossible: ${supersedeError.message}`);
    }
  }

  const { data, error } = await supabase
    .from("memory_items")
    .update({ status: "active", last_confirmed_at: new Date().toISOString() })
    .eq("id", memoryItemId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Confirmation du souvenir impossible: ${error?.message}`);
  }

  return rowToMemoryItem(data);
}

export async function rejectMemory(
  supabase: SupabaseClient<Database>,
  memoryItemId: string,
): Promise<void> {
  const { error } = await supabase
    .from("memory_items")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .eq("id", memoryItemId);

  if (error) {
    throw new Error(`Rejet du souvenir impossible: ${error.message}`);
  }
}

// --- Lecture --------------------------------------------------------------

export async function retrieveRelevantMemories(
  supabase: SupabaseClient<Database>,
  query: MemoryRetrievalQuery,
  retriever: MemoryRetriever = defaultRetriever,
): Promise<MemoryItem[]> {
  return retriever.retrieve(supabase, query);
}
