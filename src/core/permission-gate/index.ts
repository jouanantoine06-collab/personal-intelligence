// Permission Gate — frontière de sécurité indépendante du raisonnement du modèle
// (docs/architecture/system-architecture.md). Étant donné une action + son niveau
// de risque + la politique de l'utilisateur (autorisations déjà accordées), décide
// si l'action peut s'exécuter. N'exécute jamais rien elle-même.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ToolPermissionScope, ToolRiskLevel } from "@/lib/supabase/database.types";

export type PermissionDecision = { status: "allowed" } | { status: "requires_confirmation" };

export async function checkPermission(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    conversationId: string;
    toolName: string;
    riskLevel: ToolRiskLevel;
  },
): Promise<PermissionDecision> {
  if (params.riskLevel === "no_risk") {
    return { status: "allowed" };
  }

  const { data, error } = await supabase
    .from("tool_permissions")
    .select("scope, conversation_id")
    .eq("user_id", params.userId)
    .eq("tool_name", params.toolName);

  if (error) {
    throw new Error(`Vérification de permission impossible: ${error.message}`);
  }

  const hasStandingGrant = (data ?? []).some(
    (row) =>
      row.scope === "always" ||
      (row.scope === "session" && row.conversation_id === params.conversationId),
  );

  return hasStandingGrant ? { status: "allowed" } : { status: "requires_confirmation" };
}

export async function grantPermission(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    toolName: string;
    scope: ToolPermissionScope;
    conversationId: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("tool_permissions").insert({
    user_id: params.userId,
    tool_name: params.toolName,
    scope: params.scope,
    conversation_id: params.scope === "session" ? params.conversationId : null,
  });

  if (error) {
    throw new Error(`Octroi de permission impossible: ${error.message}`);
  }
}
