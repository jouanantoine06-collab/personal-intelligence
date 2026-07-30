// Orchestrateur — seul point de décision du tour (docs/architecture/system-architecture.md).
// Coordonne Context Engine, Memory Engine et AI Provider ; ne contient aucune logique
// métier propre à un autre composant.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { AIProvider, AIMessage, AIToolDefinition } from "@/core/ai-provider/types";
import { userText, assistantText } from "@/core/ai-provider/types";
import { recordAuditEvent } from "@/core/audit-journal/index";
import { getContextState, upsertContextState } from "@/core/context-engine/index";
import {
  classifyCandidate,
  confirmMemory,
  extractCandidate,
  proposeMemory,
  rejectMemory,
  retrieveRelevantMemories,
} from "@/core/memory-engine/index";
import { flagMemoryCandidateToolInputSchema } from "@/core/memory-engine/schemas";
import { MemoryStateConflictError } from "@/core/memory-engine/errors";
import { resolvePendingConfirmation } from "@/core/orchestrator/confirmation";
import { buildSystemPrompt } from "@/core/orchestrator/system-prompt";

const MAX_TOOL_ITERATIONS = 4;
const RECENT_MESSAGES_LIMIT = 20;
const RETRIEVAL_LIMIT = 10;

const FLAG_MEMORY_CANDIDATE_TOOL: AIToolDefinition = {
  name: "flag_memory_candidate",
  description:
    "Signale une déclaration de l'utilisateur qui mérite d'être proposée à la mémorisation.",
  inputSchema: flagMemoryCandidateToolInputSchema,
};

export interface RunTurnParams {
  userId: string;
  conversationId: string;
  userMessageText: string;
  device: string;
  modality: string;
}

export interface RunTurnResult {
  assistantText: string;
}

export async function runTurn(
  supabase: SupabaseClient<Database>,
  aiProvider: AIProvider,
  params: RunTurnParams,
): Promise<RunTurnResult> {
  const turnId = crypto.randomUUID();
  const { userId, conversationId, userMessageText } = params;

  await recordAuditEvent(supabase, {
    userId,
    turnId,
    eventType: "turn_started",
    payload: { conversationId, userMessageText },
  });

  try {
    const contextState = await getContextState(supabase, userId);

    const { error: insertUserMessageError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: userMessageText,
      turn_id: turnId,
    });
    if (insertUserMessageError) {
      throw new Error(`Écriture du message utilisateur impossible: ${insertUserMessageError.message}`);
    }

    // Résolution d'une confirmation de mémorisation en attente, s'il y en a une.
    let confirmationOutcomeNote: string | null = null;
    const pending = contextState.pendingConfirmations[0];
    if (pending) {
      const outcome = await resolvePendingConfirmation(aiProvider, {
        pendingContent: pending.content,
        userMessage: userMessageText,
      });

      if (outcome === "confirm" || outcome === "reject") {
        try {
          if (outcome === "confirm") {
            await confirmMemory(supabase, userId, pending.memoryItemId);
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_confirmed",
              payload: { memoryItemId: pending.memoryItemId, source: "chat" },
            });
            confirmationOutcomeNote = `Le souvenir "${pending.content}" vient d'être confirmé et mémorisé. Accuse-en réception naturellement.`;
          } else {
            await rejectMemory(supabase, userId, pending.memoryItemId);
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_rejected",
              payload: { memoryItemId: pending.memoryItemId, source: "chat" },
            });
            confirmationOutcomeNote = `La proposition "${pending.content}" a été refusée et n'a pas été mémorisée. Accuse-en réception naturellement.`;
          }
        } catch (conflictError) {
          if (conflictError instanceof MemoryStateConflictError) {
            // Déjà résolue entretemps depuis l'interface de gestion mémoire — pas
            // un échec de tour, juste un état à nettoyer côté conversationnel.
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_confirmation_deferred",
              payload: {
                memoryItemId: pending.memoryItemId,
                reason: "already_resolved_elsewhere",
              },
            });
          } else {
            throw conflictError;
          }
        }
        contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
          (p) => p.memoryItemId !== pending.memoryItemId,
        );
      } else {
        await recordAuditEvent(supabase, {
          userId,
          turnId,
          eventType: "memory_confirmation_deferred",
          payload: { memoryItemId: pending.memoryItemId },
        });
      }
    }

    const relevantMemories = await retrieveRelevantMemories(supabase, {
      userId,
      queryText: userMessageText,
      activeProjectId: contextState.activeProjectId,
      limit: RETRIEVAL_LIMIT,
    });
    await recordAuditEvent(supabase, {
      userId,
      turnId,
      eventType: "memory_retrieved",
      payload: { count: relevantMemories.length, ids: relevantMemories.map((m) => m.id) },
    });

    const { data: recentRows, error: recentError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(RECENT_MESSAGES_LIMIT);
    if (recentError) {
      throw new Error(`Lecture de l'historique impossible: ${recentError.message}`);
    }

    const messages: AIMessage[] = (recentRows ?? []).map((row) =>
      row.role === "user" ? userText(row.content) : assistantText(row.content),
    );

    const system = buildSystemPrompt({ relevantMemories, contextState, confirmationOutcomeNote });

    let finalText: string | null = null;
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS && finalText === null) {
      iterations += 1;
      const result = await aiProvider.complete({
        tier: "reasoning",
        system,
        messages,
        tools: [FLAG_MEMORY_CANDIDATE_TOOL],
      });

      const toolCall = result.toolCalls[0];
      if (!toolCall) {
        finalText = result.textSummary ?? "";
        break;
      }

      messages.push({ role: "assistant", content: result.content });

      let toolResultText: string;
      if (toolCall.name === "flag_memory_candidate") {
        const rawStatement = String(toolCall.input.raw_statement ?? "");
        const isExplicitRequest = Boolean(toolCall.input.is_explicit_request);
        const candidate = await extractCandidate(aiProvider, rawStatement, isExplicitRequest);

        if (!candidate) {
          await recordAuditEvent(supabase, {
            userId,
            turnId,
            eventType: "memory_candidate_rejected_invalid",
            payload: { rawStatement },
          });
          toolResultText = "Extraction impossible : information non mémorisée.";
        } else {
          classifyCandidate(candidate); // V0.1 : toujours "propose" (ADR-0008).
          const { memoryItem, supersedes } = await proposeMemory(supabase, {
            userId,
            turnId,
            candidate,
          });
          await recordAuditEvent(supabase, {
            userId,
            turnId,
            eventType: "memory_candidate_proposed",
            payload: { memoryItemId: memoryItem.id, candidate, supersedesId: supersedes?.id ?? null },
          });
          contextState.pendingConfirmations = [
            ...contextState.pendingConfirmations,
            {
              kind: "memory_proposal",
              memoryItemId: memoryItem.id,
              content: candidate.content,
              createdAt: new Date().toISOString(),
            },
          ];
          toolResultText = `Proposition enregistrée, en attente de confirmation utilisateur : "${candidate.content}"${
            supersedes ? ` (remplacerait : "${supersedes.content}")` : ""
          }. Ce n'est pas encore mémorisé définitivement — demande confirmation à l'utilisateur.`;
        }
      } else {
        toolResultText = "Outil inconnu.";
      }

      messages.push({
        role: "user",
        content: [{ type: "tool_result", toolUseId: toolCall.id, content: toolResultText }],
      });
    }

    if (finalText === null) {
      finalText = "Je n'ai pas pu terminer cette action.";
      await recordAuditEvent(supabase, {
        userId,
        turnId,
        eventType: "turn_failed",
        payload: { reason: "max_tool_iterations" },
      });
    }

    const { error: insertAssistantMessageError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      content: finalText,
      turn_id: turnId,
    });
    if (insertAssistantMessageError) {
      throw new Error(
        `Écriture du message assistant impossible: ${insertAssistantMessageError.message}`,
      );
    }

    contextState.lastDevice = params.device;
    contextState.lastModality = params.modality;
    await upsertContextState(supabase, contextState);

    await recordAuditEvent(supabase, {
      userId,
      turnId,
      eventType: "turn_completed",
      payload: { iterations },
    });

    return { assistantText: finalText };
  } catch (error) {
    await recordAuditEvent(supabase, {
      userId,
      turnId,
      eventType: "turn_failed",
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
