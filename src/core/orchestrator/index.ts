// Orchestrateur — seul point de décision du tour (docs/architecture/system-architecture.md).
// Coordonne Context Engine, Memory Engine et AI Provider ; ne contient aucune logique
// métier propre à un autre composant.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ToolExecutionPendingConfirmation } from "@/lib/supabase/database.types";
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
import {
  RESOLVE_PENDING_CONFIRMATION_TOOL_NAME,
  buildResolvePendingConfirmationTool,
  parseResolvePendingConfirmationInput,
} from "@/core/orchestrator/resolve-pending-confirmation-tool";
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

  // Confirmations d'outil éligibles à résolution dans CE tour : uniquement celles
  // créées dans LA MÊME conversation (V1.2 — jamais résolues par un message venu
  // d'ailleurs). Calculé une fois, avant toute mutation de contextState.
  let eligibleToolConfirmations: ToolExecutionPendingConfirmation[] = [];
  // Confirmations effectivement traitées (résolues ou expirées) pendant ce tour —
  // celles qui restent à la fin, parmi les éligibles, expirent faute d'avoir été
  // adressées (ni confirmées, ni rejetées, ni même jugées "sans rapport").
  const addressedConfirmationIds = new Set<string>();

  const contextState = await getContextState(supabase, userId);

  const expireUnaddressedEligibleConfirmations = async (reason: string): Promise<void> => {
    const unaddressed = eligibleToolConfirmations.filter((p) => !addressedConfirmationIds.has(p.id));
    if (unaddressed.length === 0) return;

    for (const item of unaddressed) {
      await recordAuditEvent(supabase, {
        userId,
        turnId,
        eventType: "tool_permission_expired",
        payload: { confirmationId: item.id, toolName: item.toolName, reason },
      });
    }
    const unaddressedIds = new Set(unaddressed.map((p) => p.id));
    contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
      (p) => !(p.kind === "tool_execution" && unaddressedIds.has(p.id)),
    );
  };

  try {
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

    // Résolution d'une proposition de mémorisation en attente (inchangé, V1.1).
    let outcomeNote: string | null = null;
    // Empêche flag_memory_candidate de reproposer, dans ce même tour, le fait
    // qui vient tout juste d'être confirmé ou refusé (bug réel observé : le
    // modèle relit l'historique récent — qui contient toujours le message
    // d'origine — et re-déclenche l'extraction pour le même contenu).
    let memoryJustResolvedThisTurn = false;
    const pendingMemory = contextState.pendingConfirmations.find((p) => p.kind === "memory_proposal");
    if (pendingMemory) {
      const outcome = await resolvePendingConfirmation(aiProvider, {
        pendingContent: pendingMemory.content,
        userMessage: userMessageText,
      });

      if (outcome === "confirm" || outcome === "reject") {
        memoryJustResolvedThisTurn = true;
        try {
          if (outcome === "confirm") {
            await confirmMemory(supabase, userId, pendingMemory.memoryItemId);
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_confirmed",
              payload: { memoryItemId: pendingMemory.memoryItemId, source: "chat" },
            });
            outcomeNote = `Le souvenir "${pendingMemory.content}" vient d'être confirmé et mémorisé. Accuse-en réception naturellement.`;
          } else {
            await rejectMemory(supabase, userId, pendingMemory.memoryItemId);
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_rejected",
              payload: { memoryItemId: pendingMemory.memoryItemId, source: "chat" },
            });
            outcomeNote = `La proposition "${pendingMemory.content}" a été refusée et n'a pas été mémorisée. Accuse-en réception naturellement.`;
          }
        } catch (conflictError) {
          if (conflictError instanceof MemoryStateConflictError) {
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "memory_confirmation_deferred",
              payload: {
                memoryItemId: pendingMemory.memoryItemId,
                reason: "already_resolved_elsewhere",
              },
            });
          } else {
            throw conflictError;
          }
        }
        contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
          (p) => p !== pendingMemory,
        );
      } else {
        await recordAuditEvent(supabase, {
          userId,
          turnId,
          eventType: "memory_confirmation_deferred",
          payload: { memoryItemId: pendingMemory.memoryItemId },
        });
      }
    }

    eligibleToolConfirmations = contextState.pendingConfirmations.filter(
      (p): p is ToolExecutionPendingConfirmation =>
        p.kind === "tool_execution" && p.conversationId === conversationId,
    );

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

    // Les N DERNIERS messages, dans l'ordre chronologique : on trie en
    // décroissant pour que `limit` retienne la fin de la conversation plutôt
    // que son tout début, puis on remet en ordre croissant pour l'appel IA.
    const { data: recentRowsDesc, error: recentError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGES_LIMIT);
    if (recentError) {
      throw new Error(`Lecture de l'historique impossible: ${recentError.message}`);
    }

    const recentRows = (recentRowsDesc ?? []).slice().reverse();
    const messages: AIMessage[] = recentRows.map((row) =>
      row.role === "user" ? userText(row.content) : assistantText(row.content),
    );

    const system = buildSystemPrompt({
      relevantMemories,
      contextState,
      outcomeNotes: [outcomeNote],
      pendingToolConfirmations: eligibleToolConfirmations.map((p) => ({
        id: p.id,
        toolName: p.toolName,
      })),
    });

    let finalText: string | null = null;
    let iterations = 0;
    // Empêche, de façon déterministe (pas seulement par consigne au modèle), qu'un
    // même outil soit re-proposé à la confirmation deux fois dans le même tour.
    const toolsAlreadyAwaitingConfirmationThisTurn = new Set<string>();

    const tools: AIToolDefinition[] = [
      ...(memoryJustResolvedThisTurn ? [] : [FLAG_MEMORY_CANDIDATE_TOOL]),
      ...listToolsForAI(),
    ];
    if (eligibleToolConfirmations.length > 0) {
      tools.push(buildResolvePendingConfirmationTool(eligibleToolConfirmations.map((p) => p.id)));
    }

    while (iterations < MAX_TOOL_ITERATIONS && finalText === null) {
      iterations += 1;
      const result = await aiProvider.complete({ tier: "reasoning", system, messages, tools });

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
      } else if (toolCall.name === RESOLVE_PENDING_CONFIRMATION_TOOL_NAME) {
        const rawInput = toolCall.input as Record<string, unknown>;
        const rawConfirmationId =
          typeof rawInput.confirmationId === "string" ? rawInput.confirmationId : undefined;
        const parsed = parseResolvePendingConfirmationInput(rawInput);

        const pendingItem = parsed
          ? eligibleToolConfirmations.find((p) => p.id === parsed.confirmationId)
          : rawConfirmationId
            ? eligibleToolConfirmations.find((p) => p.id === rawConfirmationId)
            : undefined;

        if (!pendingItem) {
          toolResultText =
            "Aucune confirmation en attente ne correspond à cet identifiant pour cette conversation. Aucune action n'a été exécutée.";
        } else if (addressedConfirmationIds.has(pendingItem.id)) {
          toolResultText = `La confirmation pour "${pendingItem.toolName}" a déjà été traitée dans cette même réponse. N'y reviens pas.`;
        } else if (!parsed) {
          // Sortie invalide/ambiguë (champ additionnel, scope manquant pour un
          // "confirm", décision inconnue...) : jamais exécutée, expire immédiatement
          // — le modèle propose, le code dispose.
          addressedConfirmationIds.add(pendingItem.id);
          await recordAuditEvent(supabase, {
            userId,
            turnId,
            eventType: "tool_permission_expired",
            payload: { confirmationId: pendingItem.id, toolName: pendingItem.toolName, reason: "invalid_resolution_output" },
          });
          contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
            (p) => !(p.kind === "tool_execution" && p.id === pendingItem.id),
          );
          toolResultText = `Décision invalide ou ambiguë pour "${pendingItem.toolName}" : aucune action n'a été exécutée, la confirmation a expiré. Demande une clarification honnête à l'utilisateur s'il souhaite toujours cette action — il devra la redemander.`;
        } else {
          addressedConfirmationIds.add(pendingItem.id);

          if (parsed.decision === "reject") {
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "tool_permission_denied",
              payload: { confirmationId: pendingItem.id, toolName: pendingItem.toolName, source: "chat" },
            });
            contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
              (p) => !(p.kind === "tool_execution" && p.id === pendingItem.id),
            );
            toolResultText = `L'action "${pendingItem.toolName}" a été refusée par l'utilisateur et n'a PAS été exécutée. N'appelle pas cet outil à nouveau dans cette réponse — accuse simplement réception du refus.`;
          } else if (parsed.decision === "unrelated" || parsed.decision === "clarify") {
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "tool_permission_expired",
              payload: {
                confirmationId: pendingItem.id,
                toolName: pendingItem.toolName,
                reason: parsed.decision === "unrelated" ? "unrelated_message" : "ambiguous_clarify_requested",
              },
            });
            contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
              (p) => !(p.kind === "tool_execution" && p.id === pendingItem.id),
            );
            toolResultText =
              parsed.decision === "unrelated"
                ? `Ce message ne répond pas à la confirmation en attente pour "${pendingItem.toolName}", qui a donc expiré (jamais exécutée). Traite le message de l'utilisateur normalement.`
                : `La réponse est ambiguë : la confirmation pour "${pendingItem.toolName}" a expiré sans être exécutée. Si l'utilisateur veut toujours cette action, il devra la redemander — demande-lui une clarification honnête maintenant.`;
          } else {
            // decision === "confirm" avec un scope valide (garanti par le schéma).
            if (parsed.scope === "session" || parsed.scope === "always") {
              await grantPermission(supabase, {
                userId,
                toolName: pendingItem.toolName,
                scope: parsed.scope,
                conversationId,
              });
              await recordAuditEvent(supabase, {
                userId,
                turnId,
                eventType: "tool_permission_granted",
                payload: {
                  confirmationId: pendingItem.id,
                  toolName: pendingItem.toolName,
                  scope: parsed.scope,
                  source: "chat",
                },
              });
            }

            // Payload FIGÉ au moment de la demande initiale — jamais celui du tool
            // call de résolution, qui ne transporte ni ne peut transporter de
            // contenu de remplacement (schéma strict, additionalProperties: false).
            const outcome = await executeTool(supabase, {
              userId,
              turnId,
              toolName: pendingItem.toolName,
              rawInput: pendingItem.rawInput,
              authorization: { status: "allowed" },
            });

            contextState.pendingConfirmations = contextState.pendingConfirmations.filter(
              (p) => !(p.kind === "tool_execution" && p.id === pendingItem.id),
            );

            toolResultText =
              outcome.status === "executed"
                ? `Autorisation accordée (${parsed.scope}) et action DÉJÀ EXÉCUTÉE à l'instant, une seule fois : ${describeToolResult(pendingItem.toolName, outcome.result)} N'appelle PAS à nouveau cet outil dans cette réponse pour la même demande — contente-toi d'accuser réception du résultat ci-dessus.`
                : `Autorisation accordée (${parsed.scope}), mais l'exécution de "${pendingItem.toolName}" a échoué (${
                    outcome.status === "invalid_input" || outcome.status === "error"
                      ? outcome.message
                      : "outil inconnu"
                  }). N'appelle pas à nouveau cet outil dans cette réponse — informe l'utilisateur honnêtement de l'échec, sans prétendre que l'action a réussi.`;
          }
        }
      } else {
        const tool = getTool(toolCall.name);
        if (!tool) {
          toolResultText = "Outil inconnu.";
        } else if (toolsAlreadyAwaitingConfirmationThisTurn.has(tool.name)) {
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
            const newConfirmationId = crypto.randomUUID();
            contextState.pendingConfirmations = [
              ...contextState.pendingConfirmations.filter(
                (p) => !(p.kind === "tool_execution" && p.toolName === tool.name),
              ),
              {
                kind: "tool_execution",
                id: newConfirmationId,
                toolName: tool.name,
                rawInput: toolCall.input,
                riskLevel: tool.riskLevel,
                conversationId,
                createdAt: new Date().toISOString(),
              },
            ];
            await recordAuditEvent(supabase, {
              userId,
              turnId,
              eventType: "tool_permission_requested",
              payload: { confirmationId: newConfirmationId, toolName: tool.name, riskLevel: tool.riskLevel },
            });
            toolResultText = `Autorisation requise avant d'exécuter "${tool.name}" (identifiant de confirmation : ${newConfirmationId}). Ce n'est pas encore exécuté — demande à l'utilisateur s'il autorise une seule fois, pour cette session, ou toujours, ou s'il refuse.`;
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

    // Toute confirmation éligible que ce tour n'a pas adressée expire ici — son
    // unique chance de résolution vient de s'écouler (V1.2, ADR sur la résolution
    // pilotée par le modèle principal).
    await expireUnaddressedEligibleConfirmations("not_addressed_this_turn");

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
    // Même en cas d'échec du tour (erreur ou timeout du modèle inclus), toute
    // confirmation éligible non adressée expire : son unique chance vient de
    // s'écouler, elle ne doit jamais survivre pour être résolue par un tour futur
    // sans rapport.
    try {
      await expireUnaddressedEligibleConfirmations("turn_error");
      await upsertContextState(supabase, contextState);
    } catch (cleanupError) {
      console.error("Échec du nettoyage des confirmations en attente après erreur de tour", cleanupError);
    }

    await recordAuditEvent(supabase, {
      userId,
      turnId,
      eventType: "turn_failed",
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
