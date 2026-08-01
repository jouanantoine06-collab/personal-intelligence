// Preuve réelle (contre un vrai Postgres) de la décision de sécurité ADR-0014 :
// google_calendar_connections n'accorde AUCUN accès au rôle authenticated, même
// pour sa propre ligne — seul le client service-role peut la lire/écrire. Même
// méthode que les autres suites d'isolation RLS de ce projet.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import type { Database } from "@/lib/supabase/database.types";
import { resetTokenCipherKeyCacheForTests } from "@/lib/crypto/token-cipher";
import {
  deleteConnection,
  getConnectionStatus,
  saveConnection,
} from "@/core/google-calendar/connections";

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const SUPABASE_TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const hasTestCredentials = Boolean(
  SUPABASE_TEST_URL && SUPABASE_TEST_ANON_KEY && SUPABASE_TEST_SERVICE_ROLE_KEY,
);

describe.skipIf(!hasTestCredentials)("Isolation google_calendar_connections (ADR-0014)", () => {
  let serviceRoleClient: SupabaseClient<Database>;
  let userAClient: SupabaseClient<Database>;
  let userBClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;

  const userAEmail = `test-calendar-isolation-a-${Date.now()}@example.invalid`;
  const userBEmail = `test-calendar-isolation-b-${Date.now()}@example.invalid`;
  const password = "TestPassword123!";

  beforeAll(async () => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    resetTokenCipherKeyCacheForTests();

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
    if (userAId) {
      await serviceRoleClient.from("google_calendar_connections").delete().eq("user_id", userAId);
      await serviceRoleClient.auth.admin.deleteUser(userAId);
    }
    if (userBId) {
      await serviceRoleClient.from("google_calendar_connections").delete().eq("user_id", userBId);
      await serviceRoleClient.auth.admin.deleteUser(userBId);
    }
  });

  it("le client de session de l'utilisateur ne peut pas lire sa PROPRE ligne (deny-all réel)", async () => {
    await saveConnection(serviceRoleClient, userAId, {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresInSeconds: 3600,
      grantedScopes: "https://www.googleapis.com/auth/calendar.events",
    });

    const { data, error } = await userAClient
      .from("google_calendar_connections")
      .select("*")
      .eq("user_id", userAId);

    // RLS activée sans aucune policy pour authenticated : la requête réussit
    // mais ne renvoie jamais la moindre ligne, même la sienne.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("le client de session ne peut pas non plus insérer directement dans cette table", async () => {
    const { error } = await userBClient.from("google_calendar_connections").insert({
      user_id: userBId,
      encrypted_access_token: "x",
      encrypted_refresh_token: "y",
      token_expires_at: new Date().toISOString(),
      granted_scopes: "scope",
    });

    expect(error).not.toBeNull();
  });

  it("le client service-role peut lire/écrire, et reste isolé par user_id entre deux utilisateurs", async () => {
    await saveConnection(serviceRoleClient, userBId, {
      accessToken: "access-b",
      refreshToken: "refresh-b",
      expiresInSeconds: 3600,
      grantedScopes: "https://www.googleapis.com/auth/calendar.events",
    });

    const statusA = await getConnectionStatus(serviceRoleClient, userAId);
    const statusB = await getConnectionStatus(serviceRoleClient, userBId);

    expect(statusA.connected).toBe(true);
    expect(statusB.connected).toBe(true);

    await deleteConnection(serviceRoleClient, userAId);

    const statusAAfterDelete = await getConnectionStatus(serviceRoleClient, userAId);
    const statusBUnaffected = await getConnectionStatus(serviceRoleClient, userBId);

    expect(statusAAfterDelete.connected).toBe(false);
    expect(statusBUnaffected.connected).toBe(true);
  });
});
