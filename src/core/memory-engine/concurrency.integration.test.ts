// Tests d'intégration de concurrence — nécessitent un vrai projet Supabase (voir
// memory-management.integration.test.ts pour les variables d'environnement requises
// et les avertissements). Prouvent, contre un vrai Postgres, que les transitions
// atomiques (ADR sur l'écriture conditionnelle) empêchent réellement qu'une race
// condition produise un double succès silencieux.
//
// Une seule exécution ne prouve rien pour une race condition : chaque scénario est
// répété plusieurs fois pour obtenir un signal statistique fiable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  confirmMemory,
  deleteActiveMemory,
  proposeMemory,
  rejectMemory,
} from "@/core/memory-engine/index";
import { MemoryStateConflictError } from "@/core/memory-engine/errors";
import type { MemoryCandidate } from "@/core/memory-engine/schemas";

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const SUPABASE_TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const hasTestCredentials = Boolean(
  SUPABASE_TEST_URL && SUPABASE_TEST_ANON_KEY && SUPABASE_TEST_SERVICE_ROLE_KEY,
);

const ITERATIONS = 15;

function candidate(content: string): MemoryCandidate {
  return {
    type: "profil",
    content,
    structured_content: { key: "test_concurrency", value: content },
    confidence: 0.9,
    importance: 0.5,
    sensitivity: "normal",
    event_date: null,
    is_explicit_request: true,
  };
}

describe.skipIf(!hasTestCredentials)("Transitions atomiques sous concurrence (intégration)", () => {
  let serviceRoleClient: SupabaseClient<Database>;
  let userClient: SupabaseClient<Database>;
  let userId: string;

  const email = `test-memory-concurrency-${Date.now()}@example.invalid`;
  const password = "TestPassword123!";

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    if (userId) await serviceRoleClient.auth.admin.deleteUser(userId);
  });

  it(`confirm-vs-confirm : jamais deux succès sur ${ITERATIONS} confirmations concurrentes du même souvenir`, async () => {
    let bothSucceeded = 0;
    let exactlyOneSucceeded = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const { memoryItem } = await proposeMemory(userClient, {
        userId,
        turnId: crypto.randomUUID(),
        candidate: candidate(`confirm-vs-confirm-${i}`),
      });

      const [a, b] = await Promise.allSettled([
        confirmMemory(userClient, userId, memoryItem.id),
        confirmMemory(userClient, userId, memoryItem.id),
      ]);

      const succeededCount = [a, b].filter((r) => r.status === "fulfilled").length;
      const conflictCount = [a, b].filter(
        (r) => r.status === "rejected" && r.reason instanceof MemoryStateConflictError,
      ).length;

      if (succeededCount === 2) bothSucceeded += 1;
      if (succeededCount === 1 && conflictCount === 1) exactlyOneSucceeded += 1;

      const { data: finalRows } = await serviceRoleClient
        .from("memory_items")
        .select("status")
        .eq("id", memoryItem.id);
      expect(finalRows).toHaveLength(1); // jamais de ligne dupliquée, quoi qu'il arrive
    }

    console.log(
      `confirm-vs-confirm : ${exactlyOneSucceeded}/${ITERATIONS} conflits honnêtes, ${bothSucceeded}/${ITERATIONS} doubles succès`,
    );
    expect(bothSucceeded).toBe(0);
    expect(exactlyOneSucceeded).toBe(ITERATIONS);
  });

  it(`confirm-vs-reject : jamais deux succès sur ${ITERATIONS} résolutions concurrentes opposées`, async () => {
    let bothSucceeded = 0;
    let exactlyOneSucceeded = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const { memoryItem } = await proposeMemory(userClient, {
        userId,
        turnId: crypto.randomUUID(),
        candidate: candidate(`confirm-vs-reject-${i}`),
      });

      const [a, b] = await Promise.allSettled([
        confirmMemory(userClient, userId, memoryItem.id),
        rejectMemory(userClient, userId, memoryItem.id),
      ]);

      const succeededCount = [a, b].filter((r) => r.status === "fulfilled").length;
      const conflictCount = [a, b].filter(
        (r) => r.status === "rejected" && r.reason instanceof MemoryStateConflictError,
      ).length;

      if (succeededCount === 2) bothSucceeded += 1;
      if (succeededCount === 1 && conflictCount === 1) exactlyOneSucceeded += 1;

      const { data: finalRow } = await serviceRoleClient
        .from("memory_items")
        .select("status")
        .eq("id", memoryItem.id)
        .single();
      expect(["active", "deleted"]).toContain(finalRow?.status);
    }

    console.log(
      `confirm-vs-reject : ${exactlyOneSucceeded}/${ITERATIONS} conflits honnêtes, ${bothSucceeded}/${ITERATIONS} doubles succès`,
    );
    expect(bothSucceeded).toBe(0);
    expect(exactlyOneSucceeded).toBe(ITERATIONS);
  });

  it(`delete-vs-delete : jamais deux succès sur ${ITERATIONS} suppressions concurrentes du même souvenir actif`, async () => {
    let bothSucceeded = 0;
    let exactlyOneSucceeded = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const { memoryItem } = await proposeMemory(userClient, {
        userId,
        turnId: crypto.randomUUID(),
        candidate: candidate(`delete-vs-delete-${i}`),
      });
      await confirmMemory(userClient, userId, memoryItem.id);

      const [a, b] = await Promise.allSettled([
        deleteActiveMemory(userClient, userId, memoryItem.id),
        deleteActiveMemory(userClient, userId, memoryItem.id),
      ]);

      const succeededCount = [a, b].filter((r) => r.status === "fulfilled").length;
      const conflictCount = [a, b].filter(
        (r) => r.status === "rejected" && r.reason instanceof MemoryStateConflictError,
      ).length;

      if (succeededCount === 2) bothSucceeded += 1;
      if (succeededCount === 1 && conflictCount === 1) exactlyOneSucceeded += 1;
    }

    console.log(
      `delete-vs-delete : ${exactlyOneSucceeded}/${ITERATIONS} conflits honnêtes, ${bothSucceeded}/${ITERATIONS} doubles succès`,
    );
    expect(bothSucceeded).toBe(0);
    expect(exactlyOneSucceeded).toBe(ITERATIONS);
  });
});
