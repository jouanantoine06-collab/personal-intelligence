// Memory Engine — décide ce qui devient un fait persisté, le stocke avec son cycle
// de vie, le restitue contextuellement (docs/architecture/memory-system.md).
// Écriture et lecture restent un seul composant (voir audit d'architecture) mais sont
// organisées ici en deux zones internes clairement séparées.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { AIProvider } from "@/core/ai-provider/types";
import { userText } from "@/core/ai-provider/types";
import { parseJsonResponse } from "@/core/ai-provider/parse-json-response";
import {
  memoryCandidateSchema,
  parseStructuredContent,
  type MemoryCandidate,
} from "@/core/memory-engine/schemas";
import { rowToMemoryItem, type MemoryItem } from "@/core/memory-engine/types";
import type { MemoryRetriever, MemoryRetrievalQuery } from "@/core/memory-engine/retriever";
import { StructuredMemoryRetriever } from "@/core/memory-engine/structured-retriever";
import {
  InvalidMemoryInputError,
  MemoryNotFoundError,
  MemoryStateConflictError,
  type MemoryAction,
} from "@/core/memory-engine/errors";
import type { MemoryStatus, MemoryType } from "@/lib/supabase/database.types";

export type { MemoryItem, MemoryRetrievalQuery };
export { rowToMemoryItem };

const defaultRetriever: MemoryRetriever = new StructuredMemoryRetriever();

// --- Extraction --------------------------------------------------------------
// Étape distincte de la détection : transforme une déclaration brute (signalée par
// le modèle de raisonnement) en candidat structuré, via un appel modèle "fast".

const EXTRACTION_SYSTEM_PROMPT = `Tu extrais une information à mémoriser depuis une déclaration utilisateur.
Réponds UNIQUEMENT avec un objet JSON valide, sans balise markdown et sans balise de code (pas de \`\`\`), avec exactement ces champs :
{
  "type": "profil" | "projet" | "relationnel" | "episodique" | "temporaire" | "regles",
  "content": string (résumé court et lisible),
  "structured_content": object (forme dépend du type : profil={key,value}, projet={project_name,statut:"actif"|"en_pause"|"termine",details?}, relationnel={person_name,relation?,details?}, episodique={event,when?}, temporaire={note}, regles={rule}). Le champ "statut" d'un projet doit être EXACTEMENT l'une de ces trois valeurs, jamais une autre formulation.,
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
    const parsedJson: unknown = parseJsonResponse(result.textSummary);
    const candidate = memoryCandidateSchema.parse({
      ...(parsedJson as Record<string, unknown>),
      is_explicit_request: isExplicitRequest,
    });
    // parseStructuredContent peut substituer des valeurs (ex. .catch()) : il faut
    // réutiliser son résultat, pas seulement l'appeler pour valider et le jeter.
    candidate.structured_content = parseStructuredContent(
      candidate.type,
      candidate.structured_content,
    );
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

// Écriture conditionnelle atomique : la clause WHERE (id + user_id + statut
// attendu) décide seule si la transition a lieu — jamais une lecture préalable du
// statut suivie d'une écriture séparée (c'est exactement cette fenêtre qui a permis
// une race condition démontrée : deux confirmations concurrentes pouvaient toutes
// les deux réussir). Si aucune ligne n'est modifiée, une lecture de diagnostic
// qualifie l'erreur (introuvable vs conflit d'état) mais n'influence jamais la
// décision déjà prise par l'UPDATE lui-même.
async function performGatedUpdate(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    memoryItemId: string;
    expectedStatus: MemoryStatus;
    updatePayload: Database["public"]["Tables"]["memory_items"]["Update"];
    action: MemoryAction;
  },
): Promise<Database["public"]["Tables"]["memory_items"]["Row"]> {
  const { userId, memoryItemId, expectedStatus, updatePayload, action } = params;

  const { data, error } = await supabase
    .from("memory_items")
    .update(updatePayload)
    .eq("id", memoryItemId)
    .eq("user_id", userId)
    .eq("status", expectedStatus)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`Transition "${action}" impossible: ${error.message}`);
  }
  if (data) {
    return data;
  }

  const current = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);
  throw new MemoryStateConflictError(action, current.status);
}

export async function confirmMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<MemoryItem> {
  const confirmedRow = await performGatedUpdate(supabase, {
    userId,
    memoryItemId,
    expectedStatus: "proposed",
    updatePayload: { status: "active", last_confirmed_at: new Date().toISOString() },
    action: "confirm",
  });

  if (confirmedRow.supersedes_id) {
    // Best-effort : la confirmation elle-même a déjà réussi atomiquement ci-dessus ;
    // si l'ancien souvenir n'est plus "active" (déjà changé par ailleurs), on ne fait
    // pas échouer la confirmation pour autant — seule sa propre transition compte.
    await supabase
      .from("memory_items")
      .update({ status: "superseded" })
      .eq("id", confirmedRow.supersedes_id)
      .eq("user_id", userId)
      .eq("status", "active");
  }

  return rowToMemoryItem(confirmedRow);
}

export async function rejectMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<void> {
  await performGatedUpdate(supabase, {
    userId,
    memoryItemId,
    expectedStatus: "proposed",
    updatePayload: { status: "deleted", deleted_at: new Date().toISOString() },
    action: "reject",
  });
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
  // Lecture informationnelle uniquement (récupérer `type`, immuable, pour valider
  // structured_content) — ne sert jamais à décider si la transition est permise :
  // seule la clause WHERE status='proposed' de l'écriture ci-dessous en décide.
  const current = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);

  let validatedStructuredContent: Record<string, unknown>;
  try {
    validatedStructuredContent = parseStructuredContent(current.type, updates.structuredContent);
  } catch (validationError) {
    throw new InvalidMemoryInputError(
      `Contenu structuré invalide pour le type "${current.type}": ${
        validationError instanceof Error ? validationError.message : String(validationError)
      }`,
    );
  }

  const updatedRow = await performGatedUpdate(supabase, {
    userId,
    memoryItemId,
    expectedStatus: "proposed",
    updatePayload: { content: updates.content, structured_content: validatedStructuredContent },
    action: "edit_proposed",
  });

  return rowToMemoryItem(updatedRow);
}

// Correction d'un souvenir actif (section 4) : jamais d'écrasement silencieux —
// une nouvelle ligne "active" est créée, l'ancienne bascule "superseded".
// Déclenchée directement par une action utilisateur explicite et délibérée dans
// l'interface de gestion mémoire (source_type = "explicite"), donc sans étape de
// confirmation supplémentaire : le clic de sauvegarde EST la confirmation.
//
// Ordre important pour la sécurité sous concurrence : la supersession de l'ancien
// souvenir (gatée, atomique) a lieu AVANT l'insertion de la nouvelle version. Si
// elle échoue (l'ancien souvenir a déjà changé de statut ailleurs), aucune nouvelle
// ligne n'est créée — on évite ainsi une ligne "active" orpheline qui ne
// remplacerait plus rien de cohérent.
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

  // Lecture informationnelle uniquement (récupérer `type` pour valider le contenu
  // structuré avant toute écriture) — ne décide jamais de la transition.
  const current = await fetchOwnedMemoryItem(supabase, userId, memoryItemId);

  let validatedStructuredContent: Record<string, unknown>;
  try {
    validatedStructuredContent = parseStructuredContent(current.type, structuredContent);
  } catch (validationError) {
    throw new InvalidMemoryInputError(
      `Contenu structuré invalide pour le type "${current.type}": ${
        validationError instanceof Error ? validationError.message : String(validationError)
      }`,
    );
  }

  const supersededRow = await performGatedUpdate(supabase, {
    userId,
    memoryItemId,
    expectedStatus: "active",
    updatePayload: { status: "superseded" },
    action: "correct_active",
  });

  const { data: newRow, error: insertError } = await supabase
    .from("memory_items")
    .insert({
      user_id: userId,
      type: supersededRow.type,
      content,
      structured_content: validatedStructuredContent,
      source_type: "explicite",
      source_turn_id: null,
      event_date: supersededRow.event_date,
      confidence: supersededRow.confidence,
      importance: supersededRow.importance,
      sensitivity: supersededRow.sensitivity,
      status: "active",
      supersedes_id: supersededRow.id,
      project_id: supersededRow.project_id,
      related_person_ids: supersededRow.related_person_ids,
      last_confirmed_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (insertError || !newRow) {
    throw new Error(`Écriture de la correction impossible: ${insertError?.message}`);
  }

  return { memoryItem: rowToMemoryItem(newRow), supersededId: supersededRow.id };
}

// Suppression d'un souvenir actif (section 5) : soft-delete, jamais hors du cycle
// de vie défini par docs/architecture/memory-system.md.
export async function deleteActiveMemory(
  supabase: SupabaseClient<Database>,
  userId: string,
  memoryItemId: string,
): Promise<void> {
  await performGatedUpdate(supabase, {
    userId,
    memoryItemId,
    expectedStatus: "active",
    updatePayload: { status: "deleted", deleted_at: new Date().toISOString() },
    action: "delete_active",
  });
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
