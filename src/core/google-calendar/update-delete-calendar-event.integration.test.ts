// Test d'intégration bout en bout de update_calendar_event et
// delete_calendar_event contre un vrai Supabase, avec le même mécanisme de
// confirmation V1.2 générique déjà prouvé exhaustivement par
// create-calendar-event.integration.test.ts — ce fichier ne re-prouve pas
// tout le mécanisme depuis zéro, seulement que ces deux nouveaux outils s'y
// intègrent correctement (payload figé, isolation, erreurs Google, aucune
// fausse confirmation de succès). L'appel réseau vers Google est simulé,
// comme pour create_calendar_event.

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

const VALID_UPDATE_INPUT = {
  eventId: "existing-evt-1",
  title: "Dentiste (décalé)",
  allDay: false,
  startDateTime: "2026-08-02T16:00:00+02:00",
  endDateTime: "2026-08-02T17:00:00+02:00",
  timezone: "Europe/Paris",
};

const VALID_DELETE_INPUT = { eventId: "existing-evt-2" };

const realFetch = globalThis.fetch.bind(globalThis);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installGoogleFetchMock(handlers: {
  updateEvent?: (body: Record<string, unknown>) => Response;
  deleteEvent?: () => Response;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/calendars/primary/events/") && init?.method === "PATCH") {
        if (!handlers.updateEvent) throw new Error("updateEvent appelé sans handler fourni");
        return handlers.updateEvent(JSON.parse(init.body as string));
      }
      if (url.includes("/calendars/primary/events/") && init?.method === "DELETE") {
        if (!handlers.deleteEvent) throw new Error("deleteEvent appelé sans handler fourni");
        return handlers.deleteEvent();
      }
      return realFetch(input, init);
    }),
  );
}

describe.skipIf(!hasTestCredentials || !OAUTH_TOKEN_ENCRYPTION_KEY)(
  "update_calendar_event / delete_calendar_event — confirmation V1.2, isolation, OAuth (intégration)",
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
      fn: (ctx: { client: SupabaseClient<Database>; userId: string; conversationId: string }) => Promise<void>,
    ): Promise<void> {
      const email = `test-calendar-upddel-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
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
        expiresInSeconds: 3600,
        grantedScopes: "https://www.googleapis.com/auth/calendar.events",
      });

      try {
        await fn({ client, userId, conversationId: conversation.id });
      } finally {
        await serviceRoleClient.from("google_calendar_connections").delete().eq("user_id", userId);
        await serviceRoleClient.auth.admin.deleteUser(userId);
      }
    }

    async function requestConfirmation(
      client: SupabaseClient<Database>,
      userId: string,
      conversationId: string,
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<string> {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "req", name: toolName, input }),
          textResult("Voici un résumé, tu confirmes ?"),
        ]),
        { userId, conversationId, userMessageText: "Modifie/supprime cet événement.", device: "test", modality: "text" },
      );

      const state = await getContextState(client, userId);
      const pending = state.pendingConfirmations.find((p) => p.kind === "tool_execution");
      if (!pending || pending.kind !== "tool_execution") {
        throw new Error("Aucune confirmation d'outil créée par le tour de demande.");
      }
      return pending.id;
    }

    async function getToolExecutionEvents(
      userId: string,
      toolName: string,
    ): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
      const { data } = await serviceRoleClient
        .from("audit_journal")
        .select("event_type, payload")
        .eq("user_id", userId)
        .eq("payload->>toolName", toolName)
        .order("created_at", { ascending: true });
      return data ?? [];
    }

    it("update_calendar_event : confirmation 'once' modifie réellement l'événement (PATCH)", async () => {
      await withIsolatedUser("update-once", async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          updateEvent: (body) =>
            jsonResponse(200, {
              id: "existing-evt-1",
              summary: body.summary,
              start: body.start,
              end: body.end,
            }),
        });

        const confirmationId = await requestConfirmation(
          client,
          userId,
          conversationId,
          "update_calendar_event",
          VALID_UPDATE_INPUT,
        );

        await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "once" }),
            textResult("Modifié."),
          ]),
          { userId, conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
        );

        const events = await getToolExecutionEvents(userId, "update_calendar_event");
        const executed = events.find((e) => e.event_type === "tool_executed");
        expect(executed).toBeDefined();
        expect((executed!.payload.result as { event: { id: string } }).event.id).toBe("existing-evt-1");
      });
    });

    it("update_calendar_event : tentative de modifier le payload pendant la confirmation est rejetée", async () => {
      await withIsolatedUser("update-payload-injection", async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({}); // aucun appel Google ne doit avoir lieu

        const confirmationId = await requestConfirmation(
          client,
          userId,
          conversationId,
          "update_calendar_event",
          VALID_UPDATE_INPUT,
        );

        await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", {
              confirmationId,
              decision: "confirm",
              scope: "once",
              rawInput: { ...VALID_UPDATE_INPUT, title: "TITRE INJECTÉ" },
            }),
            textResult("D'accord."),
          ]),
          { userId, conversationId, userMessageText: "Oui, mais change le titre.", device: "test", modality: "text" },
        );

        const events = await getToolExecutionEvents(userId, "update_calendar_event");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });

    it("update_calendar_event : isolation utilisateur, jamais le même token entre deux utilisateurs", async () => {
      await withIsolatedUser("update-isolation-a", async (ctxA) => {
        await withIsolatedUser("update-isolation-b", async (ctxB) => {
          const usedTokens: string[] = [];
          vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
              const url = typeof input === "string" ? input : input.toString();
              if (url.includes("/calendars/primary/events/") && init?.method === "PATCH") {
                const authHeader = (init.headers as Record<string, string>).Authorization;
                if (!authHeader) throw new Error("Authorization header manquant");
                usedTokens.push(authHeader);
                return jsonResponse(200, { id: "existing-evt-1", ...VALID_UPDATE_INPUT });
              }
              return realFetch(input, init);
            }),
          );

          const confirmationA = await requestConfirmation(
            ctxA.client,
            ctxA.userId,
            ctxA.conversationId,
            "update_calendar_event",
            VALID_UPDATE_INPUT,
          );
          await runTurn(
            ctxA.client,
            scriptedProvider([
              resolveCall("r1", { confirmationId: confirmationA, decision: "confirm", scope: "once" }),
              textResult("Modifié pour A."),
            ]),
            { userId: ctxA.userId, conversationId: ctxA.conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
          );

          const confirmationB = await requestConfirmation(
            ctxB.client,
            ctxB.userId,
            ctxB.conversationId,
            "update_calendar_event",
            VALID_UPDATE_INPUT,
          );
          await runTurn(
            ctxB.client,
            scriptedProvider([
              resolveCall("r1", { confirmationId: confirmationB, decision: "confirm", scope: "once" }),
              textResult("Modifié pour B."),
            ]),
            { userId: ctxB.userId, conversationId: ctxB.conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
          );

          expect(usedTokens).toHaveLength(2);
          expect(usedTokens[0]).not.toBe(usedTokens[1]);
        });
      });
    });

    it("delete_calendar_event : confirmation 'once' supprime réellement l'événement (DELETE)", async () => {
      await withIsolatedUser("delete-once", async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          deleteEvent: () => new Response(null, { status: 204 }),
        });

        const confirmationId = await requestConfirmation(
          client,
          userId,
          conversationId,
          "delete_calendar_event",
          VALID_DELETE_INPUT,
        );

        const result = await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "once" }),
            textResult("Supprimé."),
          ]),
          { userId, conversationId, userMessageText: "Oui, supprime-le.", device: "test", modality: "text" },
        );
        expect(result.assistantText).toBe("Supprimé.");

        const events = await getToolExecutionEvents(userId, "delete_calendar_event");
        const executed = events.find((e) => e.event_type === "tool_executed");
        expect(executed).toBeDefined();
        expect(executed!.payload.result).toEqual({ deleted: true, eventId: "existing-evt-2" });
      });
    });

    it("delete_calendar_event : un refus n'appelle jamais Google et ne supprime rien", async () => {
      await withIsolatedUser("delete-refuse", async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({}); // toute tentative d'appel Google fait échouer le test

        const confirmationId = await requestConfirmation(
          client,
          userId,
          conversationId,
          "delete_calendar_event",
          VALID_DELETE_INPUT,
        );

        await runTurn(
          client,
          scriptedProvider([resolveCall("r1", { confirmationId, decision: "reject" }), textResult("Compris, je ne supprime rien.")]),
          { userId, conversationId, userMessageText: "Non, laisse-le.", device: "test", modality: "text" },
        );

        const events = await getToolExecutionEvents(userId, "delete_calendar_event");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });

    it("delete_calendar_event : confirmation expirée (aparté) n'exécute jamais la suppression tardivement", async () => {
      await withIsolatedUser("delete-expiree", async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({});

        const confirmationId = await requestConfirmation(
          client,
          userId,
          conversationId,
          "delete_calendar_event",
          VALID_DELETE_INPUT,
        );

        await runTurn(
          client,
          scriptedProvider([resolveCall("r1", { confirmationId, decision: "unrelated" }), textResult("Il fait beau.")]),
          { userId, conversationId, userMessageText: "Quel temps fait-il ?", device: "test", modality: "text" },
        );

        await runTurn(client, scriptedProvider([textResult("D'accord.")]), {
          userId,
          conversationId,
          userMessageText: "Oui, vas-y, supprime.",
          device: "test",
          modality: "text",
        });

        const events = await getToolExecutionEvents(userId, "delete_calendar_event");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });

    it("delete_calendar_event : une erreur Google (ex: 404 déjà supprimé autrement) n'affirme jamais un succès", async () => {
      await withIsolatedUser("delete-erreur-google", async ({ client, userId, conversationId }) => {
        installGoogleFetchMock({
          deleteEvent: () => jsonResponse(404, { error: { message: "Not Found" } }),
        });

        const confirmationId = await requestConfirmation(
          client,
          userId,
          conversationId,
          "delete_calendar_event",
          VALID_DELETE_INPUT,
        );

        const result = await runTurn(
          client,
          scriptedProvider([
            resolveCall("r1", { confirmationId, decision: "confirm", scope: "once" }),
            textResult("Je n'ai pas pu supprimer l'événement : introuvable."),
          ]),
          { userId, conversationId, userMessageText: "Oui.", device: "test", modality: "text" },
        );
        expect(result.assistantText).not.toMatch(/supprimé avec succès|c'est fait/i);

        const events = await getToolExecutionEvents(userId, "delete_calendar_event");
        expect(events.map((e) => e.event_type)).toContain("tool_execution_failed");
        expect(events.map((e) => e.event_type)).not.toContain("tool_executed");
      });
    });
  },
);
