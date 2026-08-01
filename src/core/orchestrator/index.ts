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
import { resolveToolPermissionResponse } from "@/core/orchestrator/tool-permission-resolution";
import { buildSystemPrompt } from "@/core/orchestrator/system-prompt";
import { getTool, listToolsForAI } from "@/core/tool-registry/index";
import { registerBuiltinTools } from "@/core/tool-registry/builtin-tools";
import { checkPermission, grantPermission } from "@/core/permission-gate/index";
import { executeTool } from "@/core/tool-executor/index";

// Idempotent (registerTool écrase plutôt que de lever une erreur) : sûr à
// ré-exécuter si ce module est rechargé à chaud en développement.
registerBuiltinTools();

const MAX_TOOL_ITERATIONS = 4;
const RECENT_MESSAGES_LIMIT = 20;
const RETRIEVAL_LIMIT = 10;

const FLAG_MEMORY_CANDIDATE_TOOL: AIToolDefinition = {
  name: "flag_memory_candidate",
  description:
    "Signale une déclaration de l'utilisateur qui mérite d'être proposée à la mémorisation.",
  inputSchema: flagMemoryCandidateToolInputSchema,
};

function describeToolResult(toolName: string, result: unknown): string {
  return `Outil "${toolName}" exécuté avec succès. Résultat : ${JSON.stringify(result)}`;
}

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

    // Résolution d'une confirmation en attente (mémoire ou outil), s'il y en a une.
    let outcomeNote: string | null = null;
    const pending = contextState.pendingConfirmations[0];
    if (pending?.kind === "memory_proposal") {
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
            outcomeNote = `Le souvenir "${pending.content}" vient d'être confirmé et mémorisé. Accuse-en réception naturellement.`;
          } else {
            await rejectMemory(supabase, userId, pending.memoryItemId);
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_rejected",
              payload: { memoryItemId: pending.memoryItemId, source: "chat" },
            });
            outcomeNote = `La proposition "${pending.content}" a été refusée et n'a pas été mémorisée. Accuse-en réception naturellement.`;
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
        contextState.pendingConfirmations = contextState.pendingConfirmations.slice(1);
      } else {
        await recordAuditEvent(supabase, {
          userId,
          turnId,
          eventType: "memory_confirmation_deferred",
          payload: { memoryItemId: pending.memoryItemId },
        });
      }
    } else if (pending?.kind === "tool_execution") {
      const resolution = await resolveToolPermissionResponse(aiProvider, {
        toolName: pending.toolName,
        userMessage: userMessageText,
      });

      if (resolution === "unrelated") {
        // Expiration stricte (option A) : une confirmation d'outil n'est valable que
        // pour le tour utilisateur qui suit immédiatement sa création. Si ce tour ne
        // la résout pas explicitement, elle expire ici, avant tout traitement du
        // nouveau message — jamais conservée pour un tour ultérieur sans rapport.
        // Bug réel corrigé : un message sans rapport résolvait une confirmation
        // périmée et exécutait une ancienne demande à la place de la nouvelle.
        await recordAuditEvent(supabase, {
          userId,
          turnId,
          eventType: "tool_permission_expired",
          payload: { toolName: pending.toolName, rawInput: pending.rawInput },
        });
        contextState.pendingConfirmations = contextState.pendingConfirmations.slice(1);
      } else if (resolution === "deny") {
        await recordAuditEvent(supabase, {
          userId,
          turnId,
          eventType: "tool_permission_denied",
          payload: { toolName: pending.toolName, source: "chat" },
        });
        outcomeNote = `L'action "${pending.toolName}" a été refusée par l'utilisateur et n'a PAS été exécutée. N'appelle PAS cet outil à nouveau dans cette réponse — accuse simplement réception du refus.`;
        contextState.pendingConfirmations = contextState.pendingConfirmations.slice(1);
      } else {
        if (resolution === "session" || resolution === "always") {
          await grantPermission(supabase, {
            userId,
            toolName: pending.toolName,
            scope: resolution,
            conversationId,
          });
          await recordAuditEvent(supabase, {
            userId,
            turnId,
            eventType: "tool_permission_granted",
            payload: { toolName: pending.toolName, scope: resolution, source: "chat" },
          });
        }

        const outcome = await executeTool(supabase, {
          userId,
          turnId,
          toolName: pending.toolName,
          rawInput: pending.rawInput,
          authorization: { status: "allowed" },
        });

        outcomeNote =
          outcome.status === "executed"
            ? `Autorisation accordée (${resolution}) et action DÉJÀ EXÉCUTÉE à l'instant, une seule fois : ${describeToolResult(pending.toolName, outcome.result)} N'appelle PAS à nouveau cet outil dans cette réponse pour la même demande — contente-toi d'accuser réception du résultat ci-dessus.`
            : `Autorisation accordée (${resolution}), mais l'exécution de "${pending.toolName}" a échoué (${
                outcome.status === "invalid_input" || outcome.status === "error"
                  ? outcome.message
                  : "outil inconnu"
              }). N'appelle pas à nouveau cet outil dans cette réponse — informe l'utilisateur honnêtement de l'échec, sans prétendre que l'action a réussi.`;

        contextState.pendingConfirmations = contextState.pendingConfirmations.slice(1);
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

    const system = buildSystemPrompt({ relevantMemories, contextState, outcomeNotes: [outcomeNote] });

    let finalText: string | null = null;
    let iterations = 0;
    // Empêche, de façon déterministe (pas seulement par consigne au modèle), qu'un
    // même outil soit re-proposé à la confirmation deux fois dans le même tour —
    // bug réel observé : le modèle rappelait parfois l'outil après un premier
    // "confirmation requise", empilant deux confirmations en attente distinctes.
    const toolsAlreadyAwaitingConfirmationThisTurn = new Set<string>();

    while (iterations < MAX_TOOL_ITERATIONS && finalText === null) {
      iterations += 1;
      const result = await aiProvider.complete({
        tier: "reasoning",
        system,
        messages,
        tools: [FLAG_MEMORY_CANDIDATE_TOOL, ...listToolsForAI()],
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
        const tool = getTool(toolCall.name);
        if (!tool) {
          toolResultText = "Outil inconnu.";
        } else if (toolsAlreadyAwaitingConfirmationThisTurn.has(tool.name)) {
          // Refus déterministe, pas seulement une consigne au modèle : une
          // confirmation est déjà en attente pour cet outil dans ce même tour.
          toolResultText = `Une demande d'autorisation pour "${tool.name}" est déjà en attente dans cette même réponse. N'appelle pas cet outil une seconde fois ici — termine ta réponse en attendant la décision de l'utilisateur.`;
        } else {
          const decision = await checkPermission(supabase, {
            userId,
            conversationId,
            toolName: tool.name,
            riskLevel: tool.riskLevel,
          });
          await recordAuditEvent(supabase, {
            userId,
            turnId,
            eventType: "tool_permission_checked",
            payload: { toolName: tool.name, riskLevel: tool.riskLevel, decision: decision.status },
          });

          if (decision.status === "requires_confirmation") {
            toolsAlreadyAwaitingConfirmationThisTurn.add(tool.name);
            contextState.pendingConfirmations = [
              // Une nouvelle demande pour ce même outil supersède toute confirmation
              // en attente non résolue (jamais deux confirmations empilées pour un
              // même outil — c'est exactement ce qui causait la résolution d'une
              // demande périmée par un message ultérieur sans rapport).
              ...contextState.pendingConfirmations.filter(
                (p) => !(p.kind === "tool_execution" && p.toolName === tool.name),
              ),
              {
                kind: "tool_execution",
                toolName: tool.name,
                rawInput: toolCall.input,
                riskLevel: tool.riskLevel,
                createdAt: new Date().toISOString(),
              },
            ];
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "tool_permission_requested",
              payload: { toolName: tool.name, riskLevel: tool.riskLevel },
            });
            toolResultText = `Autorisation requise avant d'exécuter "${tool.name}". Ce n'est pas encore exécuté — demande à l'utilisateur s'il autorise une seule fois, pour cette session, ou toujours, ou s'il refuse.`;
          } else {
            const outcome = await executeTool(supabase, {
              userId,
              turnId,
              toolName: tool.name,
              rawInput: toolCall.input,
              authorization: decision,
            });

            toolResultText =
              outcome.status === "executed"
                ? describeToolResult(tool.name, outcome.result)
                : `Échec de l'outil "${tool.name}" (${
                    outcome.status === "invalid_input" || outcome.status === "error"
                      ? outcome.message
                      : "outil inconnu"
                  }). N'affirme jamais que l'action a réussi.`;
          }
        }
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
