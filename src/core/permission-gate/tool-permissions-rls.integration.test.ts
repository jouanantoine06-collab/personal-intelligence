// Isolation RLS pour tool_permissions et internal_notes — même méthode et mêmes
// variables d'environnement que memory-management.integration.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { checkPermission, grantPermission } from "@/core/permission-gate/index";

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const SUPABASE_TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const hasTestCredentials = Boolean(
  SUPABASE_TEST_URL && SUPABASE_TEST_ANON_KEY && SUPABASE_TEST_SERVICE_ROLE_KEY,
);

describe.skipIf(!hasTestCredentials)("Isolation RLS — tool_permissions et internal_notes", () => {
  let serviceRoleClient: SupabaseClient<Database>;
  let userAClient: SupabaseClient<Database>;
  let userBClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;

  const userAEmail = `test-tools-isolation-a-${Date.now()}@example.invalid`;
  const userBEmail = `test-tools-isolation-b-${Date.now()}@example.invalid`;
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

  it("l'autorisation 'always' accordée par A n'est jamais vue par B — B doit toujours confirmer", async () => {
    await grantPermission(userAClient, {
      userId: userAId,
      toolName: "create_internal_note",
      scope: "always",
      conversationId: null,
    });

    const { data: conversationB } = await userBClient
      .from("conversations")
      .insert({ user_id: userBId })
      .select("id")
      .single();

    const decisionForB = await checkPermission(userBClient, {
      userId: userBId,
      conversationId: conversationB!.id,
      toolName: "create_internal_note",
      riskLevel: "reversible",
    });

    expect(decisionForB.status).toBe("requires_confirmation");
  });

  it("un utilisateur ne peut pas lire les notes internes d'un autre", async () => {
    const { data: note } = await userAClient
      .from("internal_notes")
      .insert({ user_id: userAId, content: "note privée de A" })
      .select("id")
      .single();

    const { data, error } = await userBClient.from("internal_notes").select("*").eq("id", note!.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("un utilisateur ne peut pas lire les tool_permissions d'un autre, même en filtrant explicitement par son user_id", async () => {
    const { data, error } = await userBClient
      .from("tool_permissions")
      .select("*")
      .eq("user_id", userAId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
