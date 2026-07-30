// Tests d'intégration — nécessitent un vrai projet Supabase (local via `supabase
// start`, ou un projet distant dédié aux tests). Ils prouvent des propriétés que
// des tests unitaires avec client simulé ne peuvent PAS prouver honnêtement :
// l'isolation RLS réelle entre utilisateurs au niveau Postgres, et le fait qu'un
// souvenir supprimé disparaît réellement de la récupération.
//
// Non exécutés dans cet environnement de développement (aucun projet Supabase
// provisionné ici) — voir le rapport de fin de tranche.
//
// Variables d'environnement requises :
//   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY
//
// ⚠️ Ne jamais pointer ces variables vers un projet Supabase de production : ce
// fichier crée et supprime de vrais utilisateurs de test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  confirmMemory,
  deleteActiveMemory,
  listMemoryItems,
  proposeMemory,
  retrieveRelevantMemories,
} from "@/core/memory-engine/index";
import type { MemoryCandidate } from "@/core/memory-engine/schemas";

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const SUPABASE_TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const hasTestCredentials = Boolean(
  SUPABASE_TEST_URL && SUPABASE_TEST_ANON_KEY && SUPABASE_TEST_SERVICE_ROLE_KEY,
);

function candidate(content: string): MemoryCandidate {
  return {
    type: "profil",
    content,
    structured_content: { key: "test_isolation", value: content },
    confidence: 0.9,
    importance: 0.5,
    sensitivity: "normal",
    event_date: null,
    is_explicit_request: true,
  };
}

describe.skipIf(!hasTestCredentials)("Isolation RLS et cycle de vie mémoire (intégration)", () => {
  let serviceRoleClient: SupabaseClient<Database>;
  let userAClient: SupabaseClient<Database>;
  let userBClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;

  const userAEmail = `test-memory-isolation-a-${Date.now()}@example.invalid`;
  const userBEmail = `test-memory-isolation-b-${Date.now()}@example.invalid`;
  const password = "TestPassword123!";

  beforeAll(async () => {
    serviceRoleClient = createSupabaseClient<Database>(
      SUPABASE_TEST_URL!,
      SUPABASE_TEST_SERVICE_ROLE_KEY!,
    );

    const { data: userA, error: userAError } = await serviceRoleClient.auth.admin.createUser({
      email: userAEmail,
      password,
      email_confirm: true,
    });
    if (userAError || !userA.user) throw new Error(`Création user A impossible: ${userAError?.message}`);
    userAId = userA.user.id;

    const { data: userB, error: userBError } = await serviceRoleClient.auth.admin.createUser({
      email: userBEmail,
      password,
      email_confirm: true,
    });
    if (userBError || !userB.user) throw new Error(`Création user B impossible: ${userBError?.message}`);
    userBId = userB.user.id;

    userAClient = createSupabaseClient<Database>(SUPABASE_TEST_URL!, SUPABASE_TEST_ANON_KEY!);
    userBClient = createSupabaseClient<Database>(SUPABASE_TEST_URL!, SUPABASE_TEST_ANON_KEY!);

    const { error: signInAError } = await userAClient.auth.signInWithPassword({
      email: userAEmail,
      password,
    });
    if (signInAError) throw new Error(`Connexion user A impossible: ${signInAError.message}`);

    const { error: signInBError } = await userBClient.auth.signInWithPassword({
      email: userBEmail,
      password,
    });
    if (signInBError) throw new Error(`Connexion user B impossible: ${signInBError.message}`);
  });

  afterAll(async () => {
    if (userAId) await serviceRoleClient.auth.admin.deleteUser(userAId);
    if (userBId) await serviceRoleClient.auth.admin.deleteUser(userBId);
  });

  it("un utilisateur ne peut pas lire, même explicitement, les souvenirs d'un autre", async () => {
    const { memoryItem } = await proposeMemory(userAClient, {
      userId: userAId,
      turnId: crypto.randomUUID(),
      candidate: candidate("Souvenir privé de A — lecture croisée"),
    });
    await confirmMemory(userAClient, userAId, memoryItem.id);

    // B tente de lire explicitement les souvenirs de A avec son propre client authentifié.
    const { data, error } = await userBClient
      .from("memory_items")
      .select("*")
      .eq("user_id", userAId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("un utilisateur ne peut pas modifier un souvenir d'un autre", async () => {
    const { memoryItem } = await proposeMemory(userAClient, {
      userId: userAId,
      turnId: crypto.randomUUID(),
      candidate: candidate("Souvenir privé de A — modification croisée"),
    });
    await confirmMemory(userAClient, userAId, memoryItem.id);

    const { data: updateResult, error: updateError } = await userBClient
      .from("memory_items")
      .update({ status: "deleted" })
      .eq("id", memoryItem.id)
      .select("*");

    expect(updateError).toBeNull();
    expect(updateResult).toEqual([]); // RLS : zéro ligne affectée, pas une erreur explicite.

    const { data: stillActive } = await userAClient
      .from("memory_items")
      .select("status")
      .eq("id", memoryItem.id)
      .single();
    expect(stillActive?.status).toBe("active");
  });

  it("un souvenir supprimé n'est plus retourné par MemoryRetriever", async () => {
    const uniqueMarker = `marqueur-unique-${Date.now()}`;
    const { memoryItem } = await proposeMemory(userAClient, {
      userId: userAId,
      turnId: crypto.randomUUID(),
      candidate: candidate(`Préférence à supprimer ${uniqueMarker}`),
    });
    await confirmMemory(userAClient, userAId, memoryItem.id);

    const beforeDeletion = await retrieveRelevantMemories(userAClient, {
      userId: userAId,
      queryText: uniqueMarker,
      activeProjectId: null,
      limit: 10,
    });
    expect(beforeDeletion.some((item) => item.id === memoryItem.id)).toBe(true);

    await deleteActiveMemory(userAClient, userAId, memoryItem.id);

    const afterDeletion = await retrieveRelevantMemories(userAClient, {
      userId: userAId,
      queryText: uniqueMarker,
      activeProjectId: null,
      limit: 10,
    });
    expect(afterDeletion.some((item) => item.id === memoryItem.id)).toBe(false);

    const listedActive = await listMemoryItems(userAClient, {
      userId: userAId,
      status: "active",
      queryText: uniqueMarker,
    });
    expect(listedActive.some((item) => item.id === memoryItem.id)).toBe(false);

    const listedDeleted = await listMemoryItems(userAClient, {
      userId: userAId,
      status: "deleted",
      queryText: uniqueMarker,
    });
    expect(listedDeleted.some((item) => item.id === memoryItem.id)).toBe(true);
  });
});
