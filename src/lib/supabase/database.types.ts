// Types reflétant supabase/migrations/0001_init.sql.
// Écrits à la main (pas de projet Supabase provisionné pour générer via le CLI) —
// à régénérer avec `supabase gen types typescript` dès qu'un projet réel existe.

export type MemoryType =
  | "profil"
  | "projet"
  | "relationnel"
  | "episodique"
  | "temporaire"
  | "regles";

export type MemorySourceType = "explicite" | "infere" | "resultat_outil" | "importe";
export type MemorySensitivity = "public" | "normal" | "sensible";
export type MemoryRetentionPolicy = "permanent" | "expire" | "session_only";
export type MemoryStatus = "proposed" | "active" | "superseded" | "expired" | "deleted";
export type MessageRole = "user" | "assistant";
export type ToolRiskLevel = "no_risk" | "reversible" | "external" | "sensitive";
export type ToolPermissionScope = "session" | "always";

export interface Database {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
  public: {
    Tables: {
      conversations: {
        Row: {
          id: string;
          user_id: string;
          title: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["conversations"]["Insert"]>;
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          user_id: string;
          role: MessageRole;
          content: string;
          turn_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          user_id: string;
          role: MessageRole;
          content: string;
          turn_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["messages"]["Insert"]>;
        Relationships: [];
      };
      memory_items: {
        Row: {
          id: string;
          user_id: string;
          type: MemoryType;
          content: string;
          structured_content: Record<string, unknown>;
          source_type: MemorySourceType;
          source_turn_id: string | null;
          event_date: string | null;
          last_confirmed_at: string | null;
          confidence: number;
          importance: number;
          sensitivity: MemorySensitivity;
          retention_policy: MemoryRetentionPolicy;
          status: MemoryStatus;
          supersedes_id: string | null;
          project_id: string | null;
          related_person_ids: string[];
          embedding: number[] | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: MemoryType;
          content: string;
          structured_content?: Record<string, unknown>;
          source_type: MemorySourceType;
          source_turn_id?: string | null;
          event_date?: string | null;
          last_confirmed_at?: string | null;
          confidence?: number;
          importance?: number;
          sensitivity?: MemorySensitivity;
          retention_policy?: MemoryRetentionPolicy;
          status?: MemoryStatus;
          supersedes_id?: string | null;
          project_id?: string | null;
          related_person_ids?: string[];
          embedding?: number[] | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["memory_items"]["Insert"]>;
        Relationships: [];
      };
      context_state: {
        Row: {
          user_id: string;
          active_project_id: string | null;
          active_task: string | null;
          confidence: number;
          recent_entities: unknown[];
          pending_confirmations: PendingConfirmation[];
          last_device: string | null;
          last_modality: string | null;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          active_project_id?: string | null;
          active_task?: string | null;
          confidence?: number;
          recent_entities?: unknown[];
          pending_confirmations?: PendingConfirmation[];
          last_device?: string | null;
          last_modality?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["context_state"]["Insert"]>;
        Relationships: [];
      };
      audit_journal: {
        Row: {
          id: string;
          user_id: string;
          turn_id: string | null;
          event_type: string;
          payload: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          turn_id?: string | null;
          event_type: string;
          payload?: Record<string, unknown>;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["audit_journal"]["Insert"]>;
        Relationships: [];
      };
      tool_permissions: {
        Row: {
          id: string;
          user_id: string;
          tool_name: string;
          scope: ToolPermissionScope;
          conversation_id: string | null;
          granted_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          tool_name: string;
          scope: ToolPermissionScope;
          conversation_id?: string | null;
          granted_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["tool_permissions"]["Insert"]>;
        Relationships: [];
      };
      internal_notes: {
        Row: {
          id: string;
          user_id: string;
          content: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          content: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["internal_notes"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export interface MemoryProposalPendingConfirmation {
  kind: "memory_proposal";
  memoryItemId: string;
  content: string;
  createdAt: string;
}

export interface ToolExecutionPendingConfirmation {
  kind: "tool_execution";
  toolName: string;
  rawInput: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  createdAt: string;
}

export type PendingConfirmation = MemoryProposalPendingConfirmation | ToolExecutionPendingConfirmation;
