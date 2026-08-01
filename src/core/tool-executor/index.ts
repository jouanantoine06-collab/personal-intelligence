// Tool Executor — exécute un outil déjà autorisé par le Permission Gate. Ne
// s'auto-autorise jamais : l'appelant doit fournir une autorisation "allowed" déjà
// obtenue auprès du Gate ; sans elle, refuse d'exécuter quoi que ce soit, même si
// on lui fournit un nom d'outil et une entrée valides.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getTool } from "@/core/tool-registry/index";
import type { PermissionDecision } from "@/core/permission-gate/index";
import { recordAuditEvent } from "@/core/audit-journal/index";

export type ToolExecutionOutcome =
  | { status: "executed"; result: unknown }
  | { status: "unknown_tool" }
  | { status: "invalid_input"; message: string }
  | { status: "error"; message: string };

export async function executeTool(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    turnId: string | null;
    toolName: string;
    rawInput: unknown;
    authorization: PermissionDecision;
  },
): Promise<ToolExecutionOutcome> {
  if (params.authorization.status !== "allowed") {
    // Erreur de programmation, pas une erreur utilisateur : aucun appelant ne doit
    // pouvoir atteindre ce point sans une autorisation explicite du Permission Gate.
    throw new Error(
      "Tool Executor requiert une autorisation explicite 'allowed' du Permission Gate.",
    );
  }

  const tool = getTool(params.toolName);
  if (!tool) {
    await recordAuditEvent(supabase, {
      userId: params.userId,
      turnId: params.turnId,
      eventType: "tool_execution_failed",
      payload: { toolName: params.toolName, reason: "unknown_tool" },
    });
    return { status: "unknown_tool" };
  }

  let input: unknown;
  try {
    input = tool.parseInput(params.rawInput);
  } catch (validationError) {
    const message =
      validationError instanceof Error ? validationError.message : String(validationError);
    await recordAuditEvent(supabase, {
      userId: params.userId,
      turnId: params.turnId,
      eventType: "tool_execution_failed",
      payload: { toolName: params.toolName, reason: "invalid_input", message },
    });
    return { status: "invalid_input", message };
  }

  try {
    const result = await tool.execute(input, { supabase, userId: params.userId });
    await recordAuditEvent(supabase, {
      userId: params.userId,
      turnId: params.turnId,
      eventType: "tool_executed",
      payload: { toolName: params.toolName, input, result },
    });
    return { status: "executed", result };
  } catch (executionError) {
    const message =
      executionError instanceof Error ? executionError.message : String(executionError);
    await recordAuditEvent(supabase, {
      userId: params.userId,
      turnId: params.turnId,
      eventType: "tool_execution_failed",
      payload: { toolName: params.toolName, input, reason: "execution_error", message },
    });
    return { status: "error", message };
  }
}
