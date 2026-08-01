// Test d'intégration bout en bout : Utilisateur → Orchestrateur → Permission Gate →
// Tool Registry → Tool Executor → Résultat → Audit Journal, contre un vrai Supabase
// (mêmes variables d'environnement que les autres suites d'intégration). L'AIProvider
// est simulé (scripté), pas réel : ce test prouve le câblage complet de manière
// déterministe et rapide, indépendamment du comportement du vrai modèle. Un test
// séparé avec un vrai appel Claude (scripts/e2e-validation.mjs ou équivalent) reste
// nécessaire pour couvrir ce que seul un vrai modèle peut révéler (ex. le bug réel
// de balises markdown trouvé lors de la tranche précédente).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type {
  AICompletionResult,
  AIProvider,
  AIToolCall,
} from "@/core/ai-provider/types";
import { runTurn } from "@/core/orchestrator/index";
import { clearRegistryForTests } from "@/core/tool-registry/index";
import { registerBuiltinTools } from "@/core/tool-registry/builtin-tools";
import { getContextState } from "@/core/context-engine/index";

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const SUPABASE_TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const hasTestCredentials = Boolean(
  SUPABASE_TEST_URL && SUPABASE_TEST_ANON_KEY && SUPABASE_TEST_SERVICE_ROLE_KEY,
);

// Fournisseur IA scripté : renvoie la prochaine réponse programmée à chaque appel,
// dans l'ordre. Permet de dérouler un scénario multi-tours déterministe.
function scriptedProvider(responses: AICompletionResult[]): AIProvider {
  let index = 0;
  return {
    async complete(): Promise<AICompletionResult> {
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error(`scriptedProvider: pas de réponse programmée pour l'appel n°${index}`);
      }
      return response;
    },
  };
}

function textResult(text: string): AICompletionResult {
  return { content: [{ type: "text", text }], textSummary: text, toolCalls: [] };
}

function toolUseResult(toolCall: AIToolCall): AICompletionResult {
  return {
    content: [{ type: "tool_use", ...toolCall }],
    textSummary: null,
    toolCalls: [toolCall],
  };
}

function jsonResult(payload: unknown): AICompletionResult {
  const text = JSON.stringify(payload);
  return { content: [{ type: "text", text }], textSummary: text, toolCalls: [] };
}

async function createIsolatedTestUser(
  serviceRoleClient: SupabaseClient<Database>,
  label: string,
): Promise<{ client: SupabaseClient<Database>; userId: string; conversationId: string }> {
  const email = `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
  const password = "TestPassword123!";

  const { data: user, error: userError } = await serviceRoleClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`Création utilisateur impossible: ${userError?.message}`);

  const client = createSupabaseClient<Database>(SUPABASE_TEST_URL!, SUPABASE_TEST_ANON_KEY!);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Connexion impossible: ${signInError.message}`);

  const { data: conversation, error: conversationError } = await client
    .from("conversations")
    .insert({ user_id: user.user.id })
    .select("id")
    .single();
  if (conversationError || !conversation) {
    throw new Error(`Création de conversation impossible: ${conversationError?.message}`);
  }

  return { client, userId: user.user.id, conversationId: conversation.id };
}

describe.skipIf(!hasTestCredentials)(
  "Chaîne complète Orchestrateur → Permission Gate → Tool Registry → Tool Executor (intégration)",
  () => {
    let serviceRoleClient: SupabaseClient<Database>;
    let userClient: SupabaseClient<Database>;
    let userId: string;
    let conversationId: string;

    const email = `test-tool-flow-${Date.now()}@example.invalid`;
    const password = "TestPassword123!";

    beforeAll(async () => {
      clearRegistryForTests();
      registerBuiltinTools();

      serviceRoleClient = createSupabaseClient<Database>(
        SUPABASE_TEST_URL!,
        SUPABASE_TEST_SERVICE_ROLE_KEY!,
      );

      const { data: user, error: userError } = await serviceRoleClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (userError || !user.user) throw new Error(`Création utilisateur impossible: ${userError?.message}`);
      userId = user.user.id;

      userClient = createSupabaseClient<Database>(SUPABASE_TEST_URL!, SUPABASE_TEST_ANON_KEY!);
      const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(`Connexion impossible: ${signInError.message}`);

      const { data: conversation, error: conversationError } = await userClient
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (conversationError || !conversation) {
        throw new Error(`Création de conversation impossible: ${conversationError?.message}`);
      }
      conversationId = conversation.id;
    });

    afterAll(async () => {
      if (userId) await serviceRoleClient.auth.admin.deleteUser(userId);
    });

    it("exécute directement un outil 'no_risk' sans jamais demander d'autorisation", async () => {
      const provider = scriptedProvider([
        toolUseResult({ id: "call_1", name: "list_internal_notes", input: {} }),
        textResult("Tu n'as aucune note pour le moment."),
      ]);

      const result = await runTurn(userClient, provider, {
        userId,
        conversationId,
        userMessageText: "Liste mes notes.",
        device: "test",
        modality: "text",
      });

      expect(result.assistantText).toBe("Tu n'as aucune note pour le moment.");

      const { data: auditRows } = await serviceRoleClient
        .from("audit_journal")
        .select("event_type")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      const eventTypes = (auditRows ?? []).map((r) => r.event_type);
      expect(eventTypes).toContain("tool_permission_checked");
      expect(eventTypes).toContain("tool_executed");
      expect(eventTypes).not.toContain("tool_permission_requested");
    });

    it("exige une autorisation avant d'exécuter un outil 'reversible', puis exécute une fois autorisé (once)", async () => {
      const requestProvider = scriptedProvider([
        toolUseResult({
          id: "call_2",
          name: "create_internal_note",
          input: { content: "Relire le contrat Verdict" },
        }),
        textResult("Cette action nécessite ton autorisation : une fois, pour cette session, ou toujours ?"),
      ]);

      const requestResult = await runTurn(userClient, requestProvider, {
        userId,
        conversationId,
        userMessageText: "Note que je dois relire le contrat Verdict.",
        device: "test",
        modality: "text",
      });
      expect(requestResult.assistantText).toContain("autorisation");

      const notesBeforeConfirmation = await userClient
        .from("internal_notes")
        .select("id")
        .eq("user_id", userId);
      expect(notesBeforeConfirmation.data).toHaveLength(0); // rien exécuté avant confirmation

      const confirmProvider = scriptedProvider([
        jsonResult({ outcome: "once" }), // résolution de la permission en attente
        textResult("C'est noté, une seule fois."),
      ]);

      const confirmResult = await runTurn(userClient, confirmProvider, {
        userId,
        conversationId,
        userMessageText: "Oui, vas-y, une seule fois.",
        device: "test",
        modality: "text",
      });
      expect(confirmResult.assistantText).toBe("C'est noté, une seule fois.");

      const notesAfter = await userClient.from("internal_notes").select("content").eq("user_id", userId);
      expect(notesAfter.data).toHaveLength(1);
      expect(notesAfter.data?.[0]?.content).toBe("Relire le contrat Verdict");

      // "once" ne doit jamais persister d'autorisation.
      const permissions = await userClient
        .from("tool_permissions")
        .select("*")
        .eq("user_id", userId)
        .eq("tool_name", "create_internal_note");
      expect(permissions.data).toHaveLength(0);
    });

    it("un refus n'exécute rien et ne persiste aucune autorisation", async () => {
      const requestProvider = scriptedProvider([
        toolUseResult({
          id: "call_3",
          name: "create_internal_note",
          input: { content: "Ne devrait jamais être créée" },
        }),
        textResult("Autorisation requise."),
      ]);
      await runTurn(userClient, requestProvider, {
        userId,
        conversationId,
        userMessageText: "Note un truc.",
        device: "test",
        modality: "text",
      });

      const denyProvider = scriptedProvider([
        jsonResult({ outcome: "deny" }),
        textResult("Compris, je n'enregistre rien."),
      ]);
      const denyResult = await runTurn(userClient, denyProvider, {
        userId,
        conversationId,
        userMessageText: "Non, laisse tomber.",
        device: "test",
        modality: "text",
      });
      expect(denyResult.assistantText).toBe("Compris, je n'enregistre rien.");

      const notes = await userClient
        .from("internal_notes")
        .select("content")
        .eq("user_id", userId)
        .eq("content", "Ne devrait jamais être créée");
      expect(notes.data).toHaveLength(0);

      const { data: auditRows } = await serviceRoleClient
        .from("audit_journal")
        .select("event_type")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(5);
      expect((auditRows ?? []).map((r) => r.event_type)).toContain("tool_permission_denied");
    });

    it("'always' persiste l'autorisation et dispense de redemander lors d'un appel suivant", async () => {
      const requestProvider = scriptedProvider([
        toolUseResult({
          id: "call_4",
          name: "create_internal_note",
          input: { content: "Première note avec autorisation permanente" },
        }),
        textResult("Autorisation requise."),
      ]);
      await runTurn(userClient, requestProvider, {
        userId,
        conversationId,
        userMessageText: "Note ceci définitivement.",
        device: "test",
        modality: "text",
      });

      const alwaysProvider = scriptedProvider([
        jsonResult({ outcome: "always" }),
        textResult("Enregistré, et je n'aurai plus besoin de demander."),
      ]);
      await runTurn(userClient, alwaysProvider, {
        userId,
        conversationId,
        userMessageText: "Oui, toujours.",
        device: "test",
        modality: "text",
      });

      const permissions = await userClient
        .from("tool_permissions")
        .select("scope")
        .eq("user_id", userId)
        .eq("tool_name", "create_internal_note");
      expect(permissions.data).toEqual([{ scope: "always" }]);

      // Nouvel appel du même outil : ne doit plus jamais demander de confirmation.
      const secondCallProvider = scriptedProvider([
        toolUseResult({
          id: "call_5",
          name: "create_internal_note",
          input: { content: "Deuxième note, sans nouvelle demande" },
        }),
        textResult("C'est noté."),
      ]);
      const secondResult = await runTurn(userClient, secondCallProvider, {
        userId,
        conversationId,
        userMessageText: "Note encore autre chose.",
        device: "test",
        modality: "text",
      });
      expect(secondResult.assistantText).toBe("C'est noté.");

      const notes = await userClient
        .from("internal_notes")
        .select("content")
        .eq("user_id", userId)
        .eq("content", "Deuxième note, sans nouvelle demande");
      expect(notes.data).toHaveLength(1);
    });

    it("un même outil rappelé deux fois dans le même tour n'empile jamais deux confirmations distinctes (régression)", async () => {
      // Reproduit fidèlement le bug réel observé : un modèle qui, malgré la
      // consigne, rappelle le même outil une seconde fois dans la même réponse
      // après un premier "confirmation requise". Utilisateur et conversation
      // dédiés (pas partagés avec les autres tests) pour que les événements
      // audités de ce test ne puissent être confondus avec ceux d'un autre test.
      const email = `test-tool-flow-regression-${Date.now()}@example.invalid`;
      const password = "TestPassword123!";
      const { data: user, error: userError } = await serviceRoleClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (userError || !user.user) throw new Error(`Création utilisateur impossible: ${userError?.message}`);
      const regressionUserId = user.user.id;

      const regressionClient = createSupabaseClient<Database>(SUPABASE_TEST_URL!, SUPABASE_TEST_ANON_KEY!);
      const { error: signInError } = await regressionClient.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(`Connexion impossible: ${signInError.message}`);

      const { data: conversation, error: conversationError } = await regressionClient
        .from("conversations")
        .insert({ user_id: regressionUserId })
        .select("id")
        .single();
      if (conversationError || !conversation) {
        throw new Error(`Création de conversation impossible: ${conversationError?.message}`);
      }
      const regressionConversationId = conversation.id;

      try {
        const doubleCallProvider = scriptedProvider([
          toolUseResult({ id: "call_a", name: "create_internal_note", input: { content: "Première tentative" } }),
          toolUseResult({
            id: "call_b",
            name: "create_internal_note",
            input: { content: "Seconde tentative (ne doit jamais être exécutée ni retenue)" },
          }),
          textResult("D'accord, je patiente."),
        ]);

        await runTurn(regressionClient, doubleCallProvider, {
          userId: regressionUserId,
          conversationId: regressionConversationId,
          userMessageText: "Note deux choses d'un coup.",
          device: "test",
          modality: "text",
        });

        const { data: auditRows } = await serviceRoleClient
          .from("audit_journal")
          .select("event_type")
          .eq("user_id", regressionUserId)
          .order("created_at", { ascending: true });
        const requestedEvents = (auditRows ?? []).filter((r) => r.event_type === "tool_permission_requested");
        expect(requestedEvents).toHaveLength(1); // jamais deux demandes empilées pour le même outil

        // La confirmation qui reste en attente doit porter sur la PREMIÈRE tentative,
        // jamais sur la seconde (bloquée avant même d'atteindre le Permission Gate).
        const onceProvider = scriptedProvider([jsonResult({ outcome: "once" }), textResult("C'est noté.")]);
        await runTurn(regressionClient, onceProvider, {
          userId: regressionUserId,
          conversationId: regressionConversationId,
          userMessageText: "Oui, une seule fois.",
          device: "test",
          modality: "text",
        });

        const notes = await regressionClient
          .from("internal_notes")
          .select("content")
          .eq("user_id", regressionUserId)
          .in("content", ["Première tentative", "Seconde tentative (ne doit jamais être exécutée ni retenue)"]);
        expect(notes.data).toEqual([{ content: "Première tentative" }]);
      } finally {
        await serviceRoleClient.auth.admin.deleteUser(regressionUserId);
      }
    });
  },
);

// Expiration stricte des confirmations d'outil (option A, ADR correspondant).
// Une confirmation n'est valable que pour le tour utilisateur immédiatement
// suivant sa création ; si ce tour ne la résout pas explicitement, elle expire
// avant tout traitement du nouveau message. Chaque test crée son propre
// utilisateur isolé pour ne dépendre d'aucun état partagé avec les autres suites.
describe.skipIf(!hasTestCredentials)("Expiration stricte des confirmations d'outil (intégration)", () => {
  let serviceRoleClient: SupabaseClient<Database>;

  beforeAll(() => {
    clearRegistryForTests();
    registerBuiltinTools();
    serviceRoleClient = createSupabaseClient<Database>(
      SUPABASE_TEST_URL!,
      SUPABASE_TEST_SERVICE_ROLE_KEY!,
    );
  });

  it("réponse immédiate : la confirmation est résolue normalement au tour suivant", async () => {
    const { client, userId, conversationId } = await createIsolatedTestUser(
      serviceRoleClient,
      "expiry-immediate",
    );
    try {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "c1", name: "create_internal_note", input: { content: "Note immédiate" } }),
          textResult("Autorisation requise."),
        ]),
        { userId, conversationId, userMessageText: "Note ceci.", device: "test", modality: "text" },
      );

      await runTurn(
        client,
        scriptedProvider([jsonResult({ outcome: "once" }), textResult("C'est noté.")]),
        { userId, conversationId, userMessageText: "Oui, une fois.", device: "test", modality: "text" },
      );

      const notes = await client.from("internal_notes").select("content").eq("user_id", userId);
      expect(notes.data).toEqual([{ content: "Note immédiate" }]);
    } finally {
      await serviceRoleClient.auth.admin.deleteUser(userId);
    }
  });

  it("réponse négative : la confirmation est refusée normalement au tour suivant", async () => {
    const { client, userId, conversationId } = await createIsolatedTestUser(
      serviceRoleClient,
      "expiry-negative",
    );
    try {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "c1", name: "create_internal_note", input: { content: "Ne doit jamais exister" } }),
          textResult("Autorisation requise."),
        ]),
        { userId, conversationId, userMessageText: "Note ceci.", device: "test", modality: "text" },
      );

      await runTurn(
        client,
        scriptedProvider([jsonResult({ outcome: "deny" }), textResult("Compris, rien noté.")]),
        { userId, conversationId, userMessageText: "Non.", device: "test", modality: "text" },
      );

      const notes = await client.from("internal_notes").select("content").eq("user_id", userId);
      expect(notes.data).toEqual([]);
    } finally {
      await serviceRoleClient.auth.admin.deleteUser(userId);
    }
  });

  it("aparté utilisateur avant réponse : la confirmation expire et n'est jamais exécutée par une réponse tardive", async () => {
    const { client, userId, conversationId } = await createIsolatedTestUser(serviceRoleClient, "expiry-aside");
    try {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "c1", name: "create_internal_note", input: { content: "Contenu original" } }),
          textResult("Autorisation requise."),
        ]),
        { userId, conversationId, userMessageText: "Note ceci.", device: "test", modality: "text" },
      );

      // Aparté : l'utilisateur part sur autre chose avant de répondre à la demande.
      await runTurn(
        client,
        scriptedProvider([jsonResult({ outcome: "unrelated" }), textResult("Il fait beau aujourd'hui.")]),
        { userId, conversationId, userMessageText: "Quel temps fait-il ?", device: "test", modality: "text" },
      );

      const stateAfterAside = await getContextState(client, userId);
      expect(stateAfterAside.pendingConfirmations).toEqual([]);

      const { data: expiredEvents } = await serviceRoleClient
        .from("audit_journal")
        .select("event_type")
        .eq("user_id", userId)
        .eq("event_type", "tool_permission_expired");
      expect(expiredEvents).toHaveLength(1);

      // Réponse tardive : ne doit résoudre ni exécuter la demande périmée, puisqu'il
      // n'y a plus rien en attente (le modèle ne rappelle pas l'outil ici, scénario
      // isolé volontairement pour ne tester que l'infrastructure).
      await runTurn(client, scriptedProvider([textResult("D'accord.")]), {
        userId,
        conversationId,
        userMessageText: "Oui, toujours.",
        device: "test",
        modality: "text",
      });

      const notes = await client.from("internal_notes").select("content").eq("user_id", userId);
      expect(notes.data).toEqual([]);
      const grants = await client
        .from("tool_permissions")
        .select("*")
        .eq("user_id", userId)
        .eq("tool_name", "create_internal_note");
      expect(grants.data).toEqual([]);
    } finally {
      await serviceRoleClient.auth.admin.deleteUser(userId);
    }
  });

  it("nouveau sujet : un nouvel outil demandé fait expirer l'ancienne confirmation au lieu de la résoudre à sa place (bug réel corrigé)", async () => {
    const { client, userId, conversationId } = await createIsolatedTestUser(serviceRoleClient, "expiry-topic");
    try {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "c1", name: "create_internal_note", input: { content: "X" } }),
          textResult("Autorisation requise pour X."),
        ]),
        { userId, conversationId, userMessageText: "Note X.", device: "test", modality: "text" },
      );

      // Nouveau sujet : une demande de note complètement différente, jamais une
      // réponse à la précédente.
      await runTurn(
        client,
        scriptedProvider([
          jsonResult({ outcome: "unrelated" }),
          toolUseResult({ id: "c2", name: "create_internal_note", input: { content: "Y" } }),
          textResult("Autorisation requise pour Y."),
        ]),
        { userId, conversationId, userMessageText: "Note Y.", device: "test", modality: "text" },
      );

      const stateAfterNewTopic = await getContextState(client, userId);
      expect(stateAfterNewTopic.pendingConfirmations).toHaveLength(1);
      expect(stateAfterNewTopic.pendingConfirmations[0]).toMatchObject({
        kind: "tool_execution",
        rawInput: { content: "Y" },
      });

      await runTurn(
        client,
        scriptedProvider([jsonResult({ outcome: "once" }), textResult("Y est noté.")]),
        { userId, conversationId, userMessageText: "Oui, une fois.", device: "test", modality: "text" },
      );

      const notes = await client.from("internal_notes").select("content").eq("user_id", userId);
      expect(notes.data).toEqual([{ content: "Y" }]); // jamais "X", la demande périmée
    } finally {
      await serviceRoleClient.auth.admin.deleteUser(userId);
    }
  });

  it("confirmation expirée : une réponse d'apparence positive après expiration n'exécute rien et n'accorde rien", async () => {
    const { client, userId, conversationId } = await createIsolatedTestUser(serviceRoleClient, "expiry-stale");
    try {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "c1", name: "create_internal_note", input: { content: "Périmée" } }),
          textResult("Autorisation requise."),
        ]),
        { userId, conversationId, userMessageText: "Note ceci.", device: "test", modality: "text" },
      );

      await runTurn(
        client,
        scriptedProvider([jsonResult({ outcome: "unrelated" }), textResult("D'accord.")]),
        { userId, conversationId, userMessageText: "Autre chose sans rapport.", device: "test", modality: "text" },
      );

      // Message d'apparence positive, mais rien n'est plus en attente : ne doit ni
      // accorder de permission ni exécuter la demande périmée. Le modèle scripté ne
      // rappelle pas l'outil ici (scénario isolé à l'infrastructure).
      await runTurn(client, scriptedProvider([textResult("Très bien.")]), {
        userId,
        conversationId,
        userMessageText: "Oui, toujours, vas-y.",
        device: "test",
        modality: "text",
      });

      const notes = await client.from("internal_notes").select("content").eq("user_id", userId);
      expect(notes.data).toEqual([]);
      const grants = await client.from("tool_permissions").select("*").eq("user_id", userId);
      expect(grants.data).toEqual([]);
    } finally {
      await serviceRoleClient.auth.admin.deleteUser(userId);
    }
  });

  it("absence totale de réponse : la confirmation reste en attente tant qu'aucun tour suivant n'a eu lieu", async () => {
    const { client, userId, conversationId } = await createIsolatedTestUser(serviceRoleClient, "expiry-noresponse");
    try {
      await runTurn(
        client,
        scriptedProvider([
          toolUseResult({ id: "c1", name: "create_internal_note", input: { content: "En attente" } }),
          textResult("Autorisation requise."),
        ]),
        { userId, conversationId, userMessageText: "Note ceci.", device: "test", modality: "text" },
      );

      // Aucun tour suivant n'a lieu : l'expiration est déclenchée par le traitement
      // d'un tour, jamais par une horloge en arrière-plan.
      const state = await getContextState(client, userId);
      expect(state.pendingConfirmations).toHaveLength(1);
      expect(state.pendingConfirmations[0]).toMatchObject({
        kind: "tool_execution",
        toolName: "create_internal_note",
        rawInput: { content: "En attente" },
      });
    } finally {
      await serviceRoleClient.auth.admin.deleteUser(userId);
    }
  });
});
