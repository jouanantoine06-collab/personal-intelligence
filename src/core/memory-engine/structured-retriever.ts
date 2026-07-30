// Implémentation V0.1 de MemoryRetriever : filtrage structuré + recherche plein texte
// PostgreSQL, sans embedding (ADR-0009). Trois requêtes ciblées plutôt qu'une requête
// combinée complexe, pour rester lisible et testable.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MemoryRetriever, MemoryRetrievalQuery } from "@/core/memory-engine/retriever";
import { rowToMemoryItem, type MemoryItem } from "@/core/memory-engine/types";

const ALWAYS_INCLUDED_LIMIT = 5;
const PROJECT_SCOPED_LIMIT = 5;

export class StructuredMemoryRetriever implements MemoryRetriever {
  async retrieve(
    supabase: SupabaseClient<Database>,
    query: MemoryRetrievalQuery,
  ): Promise<MemoryItem[]> {
    const byId = new Map<string, MemoryItem>();

    const { data: profileRows, error: profileError } = await supabase
      .from("memory_items")
      .select("*")
      .eq("user_id", query.userId)
      .eq("status", "active")
      .in("type", ["profil", "regles"])
      .order("importance", { ascending: false })
      .limit(ALWAYS_INCLUDED_LIMIT);

    if (profileError) {
      throw new Error(`Récupération mémoire (profil) impossible: ${profileError.message}`);
    }
    for (const row of profileRows ?? []) {
      byId.set(row.id, rowToMemoryItem(row));
    }

    if (query.activeProjectId) {
      const { data: projectRows, error: projectError } = await supabase
        .from("memory_items")
        .select("*")
        .eq("user_id", query.userId)
        .eq("status", "active")
        .eq("project_id", query.activeProjectId)
        .order("created_at", { ascending: false })
        .limit(PROJECT_SCOPED_LIMIT);

      if (projectError) {
        throw new Error(`Récupération mémoire (projet) impossible: ${projectError.message}`);
      }
      for (const row of projectRows ?? []) {
        byId.set(row.id, rowToMemoryItem(row));
      }
    }

    const remaining = query.limit - byId.size;
    if (remaining > 0 && query.queryText.trim().length > 0) {
      const { data: searchRows, error: searchError } = await supabase
        .from("memory_items")
        .select("*")
        .eq("user_id", query.userId)
        .eq("status", "active")
        .textSearch("content", query.queryText, { type: "websearch", config: "french" })
        .order("importance", { ascending: false })
        .limit(remaining);

      if (searchError) {
        throw new Error(`Récupération mémoire (recherche) impossible: ${searchError.message}`);
      }
      for (const row of searchRows ?? []) {
        byId.set(row.id, rowToMemoryItem(row));
      }
    }

    return Array.from(byId.values()).slice(0, query.limit);
  }
}
