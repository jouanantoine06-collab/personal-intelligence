// Interface d'extension (ADR-0009) : seule cette interface est consommée par le
// Memory Engine. Une implémentation par embedding pourra la remplacer plus tard
// sans modifier l'Orchestrateur ni le contrat du Memory Engine.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MemoryItem } from "@/core/memory-engine/types";

export interface MemoryRetrievalQuery {
  userId: string;
  queryText: string;
  activeProjectId: string | null;
  limit: number;
}

export interface MemoryRetriever {
  retrieve(
    supabase: SupabaseClient<Database>,
    query: MemoryRetrievalQuery,
  ): Promise<MemoryItem[]>;
}
