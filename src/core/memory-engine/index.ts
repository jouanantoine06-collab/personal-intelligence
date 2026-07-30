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
import {
  assertValidTransition,
  InvalidMemoryInputError,
  MemoryNotFoundError,
} from "@/core/memory-engine/errors";
import type { MemoryStatus, MemoryType } from "@/lib/supabase/database.types";

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

// Lit un souvenir en vérifiant son appartenance à l'utilisateur (défense en
// profondeur en plus de la RLS, qui s'applique déjà côté Postgres puisque ces
// fonctions reçoivent toujours un client scoping-session, jamais un client
// service-role).
export async function fetchOwnedMemoryItem(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<Database["public"]["Tables"]["memory_items"]["Row"]> {
  const { data, error } = await supabase
    .from("memory_items")
    .select("*")
    .eq("id", memoryItemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Lecture du souvenir impossible: ${error.message}`);
  }
  if (!data) {
    throw new MemoryNotFoundError(memoryItemId);
  }

  return data;
}

export async function confirmMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<MemoryItem> {
  const proposedRow = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  assertValidTransition(proposedRow.status, "confirm");

  if (proposedRow.supersedes_id) {
    const { error: supersedeError } = await supabase
      .from("memory_items")
      .update({ status: "superseded" })
      .eq("id", proposedRow.supersedes_id)
      .eq("user_id", userId);

    if (supersedeError) {
      throw new Error(`Supersession impossible: ${supersedeError.message}`);
    }
  }

  const { data, error } = await supabase
    .from("memory_items")
    .update({ status: "active", last_confirmed_at: new Date().toISOString() })
    .eq("id", memoryItemId)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Confirmation du souvenir impossible: ${error?.message}`);
  }

  return rowToMemoryItem(data);
}

export async function rejectMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<void> {
  const row = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  assertValidTransition(row.status, "reject");

  const { error } = await supabase
    .from("memory_items")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .eq("id", memoryItemId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Rejet du souvenir impossible: ${error.message}`);
  }
}

// Correction d'une proposition avant validation (section 2) : la ligne n'est pas
// encore "active", la modifier en place ne viole donc pas le modèle append-only
// (qui protège l'historique des souvenirs actifs, pas les brouillons en attente).
export async function editProposedMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
  updates: { content: string; structuredContent: Record<string, unknown> },
): Promise<MemoryItem> {
  const row = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  assertValidTransition(row.status, "edit_proposed");

  let validatedStructuredContent: Record<string, unknown>;
  try {
    validatedStructuredContent = parseStructuredContent(row.type, updates.structuredContent);
  } catch (validationError) {
    throw new InvalidMemoryInputError(
      `Contenu structuré invalide pour le type "${row.type}": ${
        validationError instanceof Error ? validationError.message : String(validationError)
      }`,
    );
  }

  const { data, error } = await supabase
    .from("memory_items")
    .update({ content: updates.content, structured_content: validatedStructuredContent })
    .eq("id", memoryItemId)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Édition de la proposition impossible: ${error?.message}`);
  }

  return rowToMemoryItem(data);
}

// Correction d'un souvenir actif (section 4) : jamais d'écrasement silencieux —
// une nouvelle ligne "active" est créée, l'ancienne bascule "superseded".
// Déclenchée directement par une action utilisateur explicite et délibérée dans
// l'interface de gestion mémoire (source_type = "explicite"), donc sans étape de
// confirmation supplémentaire : le clic de sauvegarde EST la confirmation.
export async function correctActiveMemory(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    memoryItemId: string;
    content: string;
    structuredContent: Record<string, unknown>;
  },
): Promise<{ memoryItem: MemoryItem; supersededId: string }> {
  const { userId, memoryItemId, content, structuredContent } = params;
  const oldRow = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  assertValidTransition(oldRow.status, "correct_active");

  let validatedStructuredContent: Record<string, unknown>;
  try {
    validatedStructuredContent = parseStructuredContent(oldRow.type, structuredContent);
  } catch (validationError) {
    throw new InvalidMemoryInputError(
      `Contenu structuré invalide pour le type "${oldRow.type}": ${
        validationError instanceof Error ? validationError.message : String(validationError)
      }`,
    );
  }

  const { data: newRow, error: insertError } = await supabase
    .from("memory_items")
    .insert({
      user_id: userId,
      type: oldRow.type,
      content,
      structured_content: validatedStructuredContent,
      source_type: "explicite",
      source_turn_id: null,
      event_date: oldRow.event_date,
      confidence: oldRow.confidence,
      importance: oldRow.importance,
      sensitivity: oldRow.sensitivity,
      status: "active",
      supersedes_id: oldRow.id,
      project_id: oldRow.project_id,
      related_person_ids: oldRow.related_person_ids,
      last_confirmed_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (insertError || !newRow) {
    throw new Error(`Écriture de la correction impossible: ${insertError?.message}`);
  }

  const { error: supersedeError } = await supabase
    .from("memory_items")
    .update({ status: "superseded" })
    .eq("id", oldRow.id)
    .eq("user_id", userId);

  if (supersedeError) {
    throw new Error(`Supersession de l'ancien souvenir impossible: ${supersedeError.message}`);
  }

  return { memoryItem: rowToMemoryItem(newRow), supersededId: oldRow.id };
}

// Suppression d'un souvenir actif (section 5) : soft-delete, jamais hors du cycle
// de vie défini par docs/architecture/memory-system.md.
export async function deleteActiveMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<void> {
  const row = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  assertValidTransition(row.status, "delete_active");

  const { error } = await supabase
    .from("memory_items")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .eq("id", memoryItemId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Suppression du souvenir impossible: ${error.message}`);
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

// --- Consultation utilisateur --------------------------------------------------
// Chemin de lecture distinct de `retrieveRelevantMemories` : celui-ci sert
// l'Orchestrateur (top-K pertinent pour un tour) ; celui-ci sert l'interface de
// gestion mémoire (parcours/filtre exhaustif, pas de classement de pertinence).
// N'implémente PAS l'interface MemoryRetriever (ADR-0009) : ce n'est pas le
// chemin de récupération contextuelle du tour.

const LIST_DEFAULT_LIMIT = 200;

export interface ListMemoryItemsParams {
  userId: string;
  type?: MemoryType;
  projectId?: string;
  status?: MemoryStatus;
  queryText?: string;
  limit?: number;
}

export interface MemoryItemWithProjectLabel extends MemoryItem {
  projectLabel: string | null;
}

async function resolveProjectLabels(
  supabase: SupabaseClient<Database>,
  userId: string,
  projectIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(projectIds));
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("memory_items")
    .select("id, content")
    .eq("user_id", userId)
    .in("id", uniqueIds);

  if (error) {
    throw new Error(`Résolution des libellés de projet impossible: ${error.message}`);
  }

  return new Map((data ?? []).map((row) => [row.id, row.content]));
}

export async function listMemoryItems(
  supabase: SupabaseClient<Database>,
  params: ListMemoryItemsParams,
): Promise<MemoryItemWithProjectLabel[]> {
  let queryBuilder = supabase
    .from("memory_items")
    .select("*")
    .eq("user_id", params.userId)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? LIST_DEFAULT_LIMIT);

  queryBuilder = queryBuilder.eq("status", params.status ?? "active");

  if (params.type) {
    queryBuilder = queryBuilder.eq("type", params.type);
  }
  if (params.projectId) {
    queryBuilder = queryBuilder.eq("project_id", params.projectId);
  }
  if (params.queryText && params.queryText.trim().length > 0) {
    queryBuilder = queryBuilder.textSearch("content", params.queryText, {
      type: "websearch",
      config: "french",
    });
  }

  const { data, error } = await queryBuilder;
  if (error) {
    throw new Error(`Liste des souvenirs impossible: ${error.message}`);
  }

  const items = (data ?? []).map(rowToMemoryItem);
  const projectLabels = await resolveProjectLabels(
    supabase,
    params.userId,
    items.map((item) => item.projectId).filter((id): id is string => id !== null),
  );

  return items.map((item) => ({
    ...item,
    projectLabel: item.projectId ? (projectLabels.get(item.projectId) ?? null) : null,
  }));
}

export interface MemoryDetail {
  item: MemoryItemWithProjectLabel;
  supersedes: MemoryItem | null; // le souvenir que celui-ci remplace
  supersededBy: MemoryItem | null; // le souvenir qui remplace celui-ci, s'il existe
  originatingMessages: { userMessage: string | null; assistantMessage: string | null } | null;
}

export async function getMemoryDetail(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<MemoryDetail> {
  const row = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  const item = rowToMemoryItem(row);

  const projectLabels = await resolveProjectLabels(
    supabase,
    userId,
    item.projectId ? [item.projectId] : [],
  );

  let supersedes: MemoryItem | null = null;
  if (row.supersedes_id) {
    const { data, error } = await supabase
      .from("memory_items")
      .select("*")
      .eq("id", row.supersedes_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      throw new Error(`Lecture du souvenir supersédé impossible: ${error.message}`);
    }
    supersedes = data ? rowToMemoryItem(data) : null;
  }

  const { data: supersededByRow, error: supersededByError } = await supabase
    .from("memory_items")
    .select("*")
    .eq("supersedes_id", memoryItemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (supersededByError) {
    throw new Error(
      `Lecture du souvenir remplaçant impossible: ${supersededByError.message}`,
    );
  }
  const supersededBy = supersededByRow ? rowToMemoryItem(supersededByRow) : null;

  let originatingMessages: MemoryDetail["originatingMessages"] = null;
  if (row.source_turn_id) {
    const { data: turnMessages, error: turnMessagesError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("user_id", userId)
      .eq("turn_id", row.source_turn_id)
      .order("created_at", { ascending: true });

    if (turnMessagesError) {
      throw new Error(`Lecture des messages d'origine impossible: ${turnMessagesError.message}`);
    }

    originatingMessages = {
      userMessage: turnMessages?.find((m) => m.role === "user")?.content ?? null,
      assistantMessage: turnMessages?.find((m) => m.role === "assistant")?.content ?? null,
    };
  }

  return {
    item: {
      ...item,
      projectLabel: item.projectId ? (projectLabels.get(item.projectId) ?? null) : null,
    },
    supersedes,
    supersededBy,
    originatingMessages,
  };
}
