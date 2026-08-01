// Test d'intégration bout en bout de create_calendar_event contre un vrai
// Supabase (google_calendar_connections réel, RLS deny-all réelle, Audit
// Journal réel), avec le mécanisme de confirmation V1.2 générique — aucun
// code nouveau pour la confirmation elle-même, "external" y est déjà traité
// exactement comme "reversible" (V1.1). Seul l'appel réseau vers Google est
// simulé : créer un vrai compte Google par utilisateur de test jetable n'est
// pas praticable. Le fetch global est intercepté uniquement pour les
// domaines google*, jamais pour les appels de Supabase lui-même.
//
// Le test réel contre un vrai compte Google (création visible dans le vrai
// calendrier) est fait séparément, en direct avec l'utilisateur.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { AICompletionResult, AIProvider, AIToolCall } from "@/core/ai-provider/types";
import { runTurn } from "@/core/orchestrator/index";
import { clearRegistryForTests } from "@/core/tool-registry/index";
import { registerBuiltinTools } from "@/core/tool-registry/builtin-tools";
import { registerGoogleCalendarTools } from "@/core/tool-registry/google-calendar-tools";
import { getContextState } from "@/core/context-engine/index";
import { saveConnection } from "@/core/google-calendar/connections";
import { resetTokenCipherKeyCacheForTests } from "@/lib/crypto/token-cipher";

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const SUPABASE_TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;

const hasTestCredentials = Boolean(
  SUPABASE_TEST_URL && SUPABASE_TEST_ANON_KEY && SUPABASE_TEST_SERVICE_ROLE_KEY,
);

function scriptedProvider(responses: AICompletionResult[]): AIProvider {
  let index = 0;
  return {
    async complete(): Promise<AICompletionResult> {
      const response = responses[index];
      index += 1;
      if (!response) throw new Error(`scriptedProvider: pas de réponse programmée n°${index}`);
      return response;
    },
  };
}

function textResult(text: string): AICompletionResult {
  return { content: [{ type: "text", text }], textSummary: text, toolCalls: [] };
}

function toolUseResult(toolCall: AIToolCall): AICompletionResult {
  return { content: [{ type: "tool_use", ...toolCall }], textSummary: null, toolCalls: [toolCall] };
}

function resolveCall(id: string, input: Record<string, unknown>): AICompletionResult {
  return toolUseResult({ id, name: "resolve_pending_confirmation", input });
}

const VALID_EVENT_INPUT = {
  title: "Dentiste",
  allDay: false,
  startDateTime: "2026-08-02T15:00:00+02:00",
  endDateTime: "2026-08-02T16:00:00+02:00",
  timezone: "Europe/Paris",
};

// N'intercepte que les domaines Google — tout le reste (Supabase) passe par
// le vrai fetch, jamais remplacé.
const realFetch = globalThis.fetch.bind(globalThis);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installGoogleFetchMock(handlers: {
  tokenRefresh?: () => Response;
  listEvents?: () => Response;
  createEvent?: (body: Record<string, unknown>) => Response;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("oauth2.googleapis.com/token")) {
        if (!handlers.tokenRefresh) throw new Error("tokenRefresh appelé sans handler fourni");
        return handlers.tokenRefresh();
      }
      if (url.includes("/calendars/primary/events") && init?.method === "POST") {
        if (!handlers.createEvent) throw new Error("createEvent appelé sans handler fourni");
        return handlers.createEvent(JSON.parse(init.body as string));
      }
      if (url.includes("/calendars/primary/events")) {
        if (!handlers.listEvents) throw new Error("listEvents appelé sans handler fourni");
        return handlers.listEvents();
      }
      return realFetch(input, init);
    }),
  );
}

describe.skipIf(!hasTestCredentials || !OAUTH_TOKEN_ENCRYPTION_KEY)(
  "create_calendar_event — confirmation V1.2, isolation, OAuth (intégration)",
  () => {
    let serviceRoleClient: SupabaseClient<Database>;

    beforeAll(() => {
      clearRegistryForTests();
      registerBuiltinTools();
      registerGoogleCalendarTools();
      serviceRoleClient = createSupabaseClient<Database>(
        SUPABASE_TEST_URL!,
        SUPABASE_TEST_SERVICE_ROLE_KEY!,
      );
      resetTokenCipherKeyCacheForTests();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function withIsolatedUser(
      label: string,
      opts: { tokenExpiresInSeconds?: number } = {},
      fn: (ctx: { client: SupabaseClient<Database>; userId: string; conversationId: string }) => Promise<void>,
    ): Promise<void> {
      const email = `test-calendar-create-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
      const password = "TestPassword123!";

      const { data: user, error: userError } = await serviceRoleClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (userError || !user.user) throw new Error(`Création utilisateur impossible: ${userError?.message}`);
      const userId = user.user.id;

      const client = createSupabaseClient<Database>(SUPABASE_TEST_URL!, SUPABASE_TEST_ANON_KEY!);
      const { error: signInError } = await client.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(`Connexion impossible: ${signInError.message}`);

      const { data: conversation, error: conversationError } = await client
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (conversationError || !conversation) {
        throw new Error(`Création de conversation impossible: ${conversationError?.message}`);
      }

      await saveConnection(serviceRoleClient, userId, {
        accessToken: `access-${label}-${randomBytes(4).toString("hex")}`,
        refreshToken: `refresh-${label}-${randomBytes(4).toString("hex")}`,
        expiresInSeconds: opts.tokenExpiresInSeconds ?? 3600,
        grantedScopes: "https://www.googleapis.com/auth/calendar.events",
      });

      try {
        await fn({ client, userId, conversationId: conversation.id });
      } finally {
        await serviceRoleClient.from("google_calendar_connections").delete().eq("user_id", userId);
        await serviceRoleClient.auth.admin.deleteUser(userId);
      }
    }

    // Demande la création (déclenche une confirmation "external") et retourne
    // l'identifiant de confirmation réel généré par l'orchestrateur.
    async function requestCreateConfirmation(
      client: SupabaseClient<Database>,
      userId: string,
      conversationId: string,
      input: Record<string, unknown> = VALID_EVENT_INPUT,
    ): Promise<string> {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "req", name: "create_calendar_event", input }),
          textResult("Voici un résumé, tu confirmes ?"),
        ]),
        {
          userId,
          conversationId,
          userMessageText: "Programme un rendez-vous chez le dentiste.",
          device: "test",
          modality: "text",
        },
      );

      const state = await getContextState(client, userId);
      const pending = state.pendingConfirmations.find((p) => p.kind === "tool_execution");
      if (!pending || pending.kind !== "tool_execution") {
        throw new Error("Aucune confirmation d'outil créée par le tour de demande.");
      }
      return pending.id;
    }

    async function getAuditEventsForConfirmation(
      userId: string,
      confirmationId: string,
    ): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
      const { data } = await serviceRoleClient
        .from("audit_journal")
        .select("event_type, payload")
        .eq("user_id", userId)
        .eq("payload->>confirmationId", confirmationId)
        .order("created_at", { ascending: true });
      return data ?? [];
    }

    // tool_executed / tool_execution_failed (journalisés par le Tool Executor,
    // pas par la branche de résolution de l'Orchestrateur) ne portent pas de
    // confirmationId dans leur payload — seulement toolName/input/result. Il
    // faut donc les chercher par nom d'outil, pas par confirmationId.
    async function getToolExecutionEvents(
      userId: string,
    ): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
      const { data } = await serviceRoleClient
        .from("audit_journal")
        .select("event_type, payload")
        .eq("user_id", userId)
        .eq("payload->>toolName", "create_calendar_event")
        .order("created_at", { ascending: true });
      return data ?? [];
    }

    it("est classé external : une confirmation est exigée avant toute création", async () => {
      await withIsolatedUser("external-required", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({});
        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);
        expect(confirmationId).toBeTruthy();

        const { data: auditRows } = await serviceRoleClient
          .from("audit_journal")
          .select("event_type")
          .eq("user_id", userId)
          .order("created_at", { ascending: true });
        const eventTypes = (auditRows ?? []).map((r) => r.event_type);
        expect(eventTypes).toContain("tool_permission_requested");
        expect(eventTypes).not.toContain("tool_executed");
      });
    });

    it("confirmation 'once' : crée réellement l'événement puis ne persiste aucune autorisation", async () => {
      await withIsolatedUser("once", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          createEvent: (body) =>
            jsonResponse(200, {
              id: "created-evt-once",
              summary: body.summary,
              start: body.start,
              end: body.end,
            }),
        });

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        const result = await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "once" }),
            textResult("C'est fait, une seule fois."),
          ]),
          { userId, conversationId, userMessageText: "Oui, vas-y.", device: "test", modality: "text" },
        );
        expect(result.assistantText).toBe("C'est fait, une seule fois.");

        const events = await getToolExecutionEvents(userId);
        const executed = events.find((e) => e.event_type === "tool_executed");
        expect(executed).toBeDefined();
        expect((executed!.payload.result as { event: { id: string } }).event.id).toBe("created-evt-once");

        const permissions = await client
          .from("tool_permissions")
          .select("*")
          .eq("user_id", userId)
          .eq("tool_name", "create_calendar_event");
        expect(permissions.data).toHaveLength(0);
      });
    });

    it("confirmation 'session' : persiste l'autorisation pour cette conversation", async () => {
      await withIsolatedUser("session", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          createEvent: () => jsonResponse(200, { id: "created-evt-session", ...VALID_EVENT_INPUT }),
        });

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "session" }),
            textResult("Créé pour cette session."),
          ]),
          { userId, conversationId, userMessageText: "Oui, pour cette session.", device: "test", modality: "text" },
        );

        const permissions = await client
          .from("tool_permissions")
          .select("scope, conversation_id")
          .eq("user_id", userId)
          .eq("tool_name", "create_calendar_event");
        expect(permissions.data).toEqual([{ scope: "session", conversation_id: conversationId }]);
      });
    });

    it("un refus n'appelle jamais Google et n'exécute rien", async () => {
      await withIsolatedUser("refus", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({}); // aucun handler : toute tentative d'appel Google fait échouer le test

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        await runTurn(
          client,
          scriptedProvider([resolveCall("r1", { confirmationId, decision: "reject" }), textResult("Compris.")]),
          { userId, conversationId, userMessageText: "Non, laisse tomber.", device: "test", modality: "text" },
        );

        const events = await getAuditEventsForConfirmation(userId, confirmationId);
        expect(events.map((e) => e.event_type)).toContain("tool_permission_denied");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });

    it("confirmation expirée (aparté) : une réponse tardive n'exécute jamais la création", async () => {
      await withIsolatedUser("expiree", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({});

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        await runTurn(
          client,
          scriptedProvider([resolveCall("r1", { confirmationId, decision: "unrelated" }), textResult("Il fait beau.")]),
          { userId, conversationId, userMessageText: "Quel temps fait-il ?", device: "test", modality: "text" },
        );

        await runTurn(client, scriptedProvider([textResult("D'accord.")]), {
          userId,
          conversationId,
          userMessageText: "Oui, toujours, vas-y.",
          device: "test",
          modality: "text",
        });

        const events = await getAuditEventsForConfirmation(userId, confirmationId);
        expect(events.map((e) => e.event_type)).toContain("tool_permission_expired");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });

    it("tentative de modifier le payload pendant la confirmation : rejetée, rien n'est créé avec le contenu injecté", async () => {
      await withIsolatedUser("payload-injection", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({}); // aucun appel Google ne doit avoir lieu

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", {
              confirmationId,
              decision: "confirm",
              scope: "once",
              rawInput: { ...VALID_EVENT_INPUT, title: "TITRE INJECTÉ" },
            }),
            textResult("D'accord."),
          ]),
          {
            userId,
            conversationId,
            userMessageText: "Oui, une fois, mais change le titre.",
            device: "test",
            modality: "text",
          },
        );

        const events = await getAuditEventsForConfirmation(userId, confirmationId);
        expect(events.map((e) => e.event_type)).toContain("tool_permission_expired");
        expect(
          events.find((e) => e.event_type === "tool_permission_expired")?.payload.reason,
        ).toBe("invalid_resolution_output");
      });
    });

    it("vérifie les chevauchements via list_calendar_events avant la confirmation, sans bloquer la création", async () => {
      await withIsolatedUser("conflit", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          listEvents: () =>
            jsonResponse(200, {
              items: [
                {
                  id: "existing-evt",
                  summary: "Déjà prévu",
                  start: { dateTime: "2026-08-02T15:30:00+02:00" },
                  end: { dateTime: "2026-08-02T15:45:00+02:00" },
                },
              ],
            }),
          createEvent: (body) => jsonResponse(200, { id: "created-evt-conflit", ...body }),
        });

        // Simule ce que le modèle réel est instruit de faire : vérifier le
        // chevauchement avant de proposer le résumé/la confirmation.
        await runTurn(
          client,
          scriptedProvider([
            toolUseResult({
              id: "check",
              name: "list_calendar_events",
              input: { timeMin: "2026-08-02T00:00:00+02:00", timeMax: "2026-08-03T00:00:00+02:00" },
            }),
            toolUseResult({ id: "req", name: "create_calendar_event", input: VALID_EVENT_INPUT }),
            textResult("Attention, un événement chevauche déjà ce créneau : « Déjà prévu ». Tu confirmes quand même ?"),
          ]),
          {
            userId,
            conversationId,
            userMessageText: "Programme le dentiste demain à 15h.",
            device: "test",
            modality: "text",
          },
        );

        const state = await getContextState(client, userId);
        const pending = state.pendingConfirmations.find((p) => p.kind === "tool_execution");
        if (!pending || pending.kind !== "tool_execution") throw new Error("confirmation attendue");

        await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId: pending.id, decision: "confirm", scope: "once" }),
            textResult("Créé malgré le chevauchement, comme demandé."),
          ]),
          { userId, conversationId, userMessageText: "Oui, quand même.", device: "test", modality: "text" },
        );

        const events = await getToolExecutionEvents(userId);
        const executed = events.find((e) => e.event_type === "tool_executed");
        expect(executed).toBeDefined();
        expect((executed!.payload.result as { event: { id: string } }).event.id).toBe("created-evt-conflit");
      });
    });

    it("une erreur Google (ex: créneau invalide) n'affirme jamais un succès", async () => {
      await withIsolatedUser("erreur-google", {}, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          createEvent: () => jsonResponse(400, { error: { message: "Invalid time range" } }),
        });

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        const result = await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "once" }),
            textResult("Je n'ai pas pu créer l'événement : Invalid time range."),
          ]),
          { userId, conversationId, userMessageText: "Oui, vas-y.", device: "test", modality: "text" },
        );
        expect(result.assistantText).not.toMatch(/créé avec succès|c'est fait/i);

        const events = await getToolExecutionEvents(userId);
        expect(events.map((e) => e.event_type)).toContain("tool_execution_failed");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });

    it("renouvelle le token automatiquement si expiré avant de créer, sans jamais exposer les secrets", async () => {
      await withIsolatedUser("refresh", { tokenExpiresInSeconds: -3600 }, async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          tokenRefresh: () =>
            jsonResponse(200, {
              access_token: "refreshed-access-token",
              expires_in: 3600,
              scope: "https://www.googleapis.com/auth/calendar.events",
            }),
          createEvent: () => jsonResponse(200, { id: "created-evt-refresh", ...VALID_EVENT_INPUT }),
        });

        const confirmationId = await requestCreateConfirmation(client, userId, conversationId);

        await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "once" }),
            textResult("C'est fait."),
          ]),
          { userId, conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
        );

        const events = await getToolExecutionEvents(userId);
        expect(events.map((e) => e.event_type)).toContain("tool_executed");
        // Aucun payload journalisé (succès ou échec) ne contient jamais de token.
        for (const event of events) {
          expect(JSON.stringify(event.payload)).not.toMatch(/refreshed-access-token|access-refresh/);
        }
      });
    });

    it("isolation utilisateur : deux comptes Google connectés en parallèle n'échangent jamais leurs tokens", async () => {
      await withIsolatedUser("isolation-a", {}, async (ctxA) => {
        await withIsolatedUser("isolation-b", {}, async (ctxB) => {
          const usedTokens: string[] = [];
          installGoogleFetchMock({
            createEvent: () => {
              return jsonResponse(200, { id: `evt-${usedTokens.length}`, ...VALID_EVENT_INPUT });
            },
          });
          // On intercepte séparément pour capturer le header Authorization par appel.
          vi.unstubAllGlobals();
          vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
              const url = typeof input === "string" ? input : input.toString();
              if (url.includes("/calendars/primary/events") && init?.method === "POST") {
                const authHeader = (init.headers as Record<string, string>).Authorization;
                if (!authHeader) throw new Error("Authorization header manquant sur l'appel de création");
                usedTokens.push(authHeader);
                return jsonResponse(200, { id: `evt-${usedTokens.length}`, ...VALID_EVENT_INPUT });
              }
              return realFetch(input, init);
            }),
          );

          const confirmationA = await requestCreateConfirmation(ctxA.client, ctxA.userId, ctxA.conversationId);
          await runTurn(
            ctxA.client,
            scriptedProvider([
              resolveCall("r1", { confirmationId: confirmationA, decision: "confirm", scope: "once" }),
              textResult("Créé pour A."),
            ]),
            { userId: ctxA.userId, conversationId: ctxA.conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
          );

          const confirmationB = await requestCreateConfirmation(ctxB.client, ctxB.userId, ctxB.conversationId);
          await runTurn(
            ctxB.client,
            scriptedProvider([
              resolveCall("r1", { confirmationId: confirmationB, decision: "confirm", scope: "once" }),
              textResult("Créé pour B."),
            ]),
            { userId: ctxB.userId, conversationId: ctxB.conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
          );

          expect(usedTokens).toHaveLength(2);
          expect(usedTokens[0]).not.toBe(usedTokens[1]);
        });
      });
    });
  },
);
