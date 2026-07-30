import type { Database } from "@/lib/supabase/database.types";
import type { MemoryType } from "@/core/memory-engine/schemas";

export type { MemoryType };

export interface MemoryItem {
  id: string;
  userId: string;
  type: MemoryType;
  content: string;
  structuredContent: Record<string, unknown>;
  sourceType: Database["public"]["Tables"]["memory_items"]["Row"]["source_type"];
  confidence: number;
  importance: number;
  sensitivity: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
  status: Database["public"]["Tables"]["memory_items"]["Row"]["status"];
  projectId: string | null;
  createdAt: string;
}

export function rowToMemoryItem(
  row: Database["public"]["Tables"]["memory_items"]["Row"],
): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    content: row.content,
    structuredContent: row.structured_content,
    sourceType: row.source_type,
    confidence: row.confidence,
    importance: row.importance,
    sensitivity: row.sensitivity,
    status: row.status,
    projectId: row.project_id,
    createdAt: row.created_at,
  };
}
