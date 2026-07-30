// Audit Journal — enregistrement append-only. Ne modifie jamais une entrée existante,
// n'interprète ni ne filtre ce qu'il reçoit (docs/architecture/system-architecture.md).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type AuditEventType =
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "memory_candidate_proposed"
  | "memory_candidate_rejected_invalid"
  | "memory_confirmed"
  | "memory_rejected"
  | "memory_confirmation_deferred"
  | "memory_retrieved"
  | "memory_proposal_edited"
  | "memory_corrected"
  | "memory_deleted";

export async function recordAuditEvent(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    turnId: string | null;
    eventType: AuditEventType;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("audit_journal").insert({
    user_id: params.userId,
    turn_id: params.turnId,
    event_type: params.eventType,
    payload: params.payload,
  });

  if (error) {
    // Le journal ne doit jamais faire échouer le tour utilisateur, mais son échec
    // doit être visible côté serveur — jamais avalé silencieusement.
    console.error("Échec d'écriture dans l'audit journal", error, params);
  }
}
