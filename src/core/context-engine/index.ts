// Context Engine — état de focus mutable, écrasé en place (ADR-0004 : un seul
// contexte actif par utilisateur en V0.1, pas de pile, pas de clé par device).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PendingConfirmation } from "@/lib/supabase/database.types";

export interface ContextState {
  userId: string;
  activeProjectId: string | null;
  activeTask: string | null;
  confidence: number;
  pendingConfirmations: PendingConfirmation[];
  lastDevice: string | null;
  lastModality: string | null;
}

function defaultState(userId: string): ContextState {
  return {
    userId,
    activeProjectId: null,
    activeTask: null,
    confidence: 0.5,
    pendingConfirmations: [],
    lastDevice: null,
    lastModality: null,
  };
}

export async function getContextState(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ContextState> {
  const { data, error } = await supabase
    .from("context_state")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Lecture du context_state impossible: ${error.message}`);
  }

  if (!data) {
    return defaultState(userId);
  }

  return {
    userId: data.user_id,
    activeProjectId: data.active_project_id,
    activeTask: data.active_task,
    confidence: data.confidence,
    pendingConfirmations: data.pending_confirmations,
    lastDevice: data.last_device,
    lastModality: data.last_modality,
  };
}

export async function upsertContextState(
  supabase: SupabaseClient<Database>,
  state: ContextState,
): Promise<void> {
  const { error } = await supabase.from("context_state").upsert({
    user_id: state.userId,
    active_project_id: state.activeProjectId,
    active_task: state.activeTask,
    confidence: state.confidence,
    pending_confirmations: state.pendingConfirmations,
    last_device: state.lastDevice,
    last_modality: state.lastModality,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Écriture du context_state impossible: ${error.message}`);
  }
}
