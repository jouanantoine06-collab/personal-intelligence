import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPermission, grantPermission } from "@/core/permission-gate/index";
import { createFakeSupabase } from "@/core/test-helpers/fake-supabase";
import type { Database } from "@/lib/supabase/database.types";

const USER_ID = "user-1";
const CONVERSATION_ID = "conv-1";
const OTHER_CONVERSATION_ID = "conv-2";

function client(rows: Record<string, unknown>[] = []) {
  return createFakeSupabase({ tool_permissions: rows }) as unknown as SupabaseClient<Database>;
}

describe("checkPermission", () => {
  it("autorise toujours un outil 'no_risk', même sans aucune permission stockée", async () => {
    const decision = await checkPermission(client([]), {
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      toolName: "list_internal_notes",
      riskLevel: "no_risk",
    });
    expect(decision.status).toBe("allowed");
  });

  it("exige une confirmation pour un outil risqué sans permission accordée", async () => {
    const decision = await checkPermission(client([]), {
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      toolName: "create_internal_note",
      riskLevel: "reversible",
    });
    expect(decision.status).toBe("requires_confirmation");
  });

  it("autorise si une permission 'always' existe pour cet outil", async () => {
    const decision = await checkPermission(
      client([{ user_id: USER_ID, tool_name: "create_internal_note", scope: "always", conversation_id: null }]),
      { userId: USER_ID, conversationId: CONVERSATION_ID, toolName: "create_internal_note", riskLevel: "reversible" },
    );
    expect(decision.status).toBe("allowed");
  });

  it("autorise si une permission 'session' existe pour LA MÊME conversation", async () => {
    const decision = await checkPermission(
      client([
        {
          user_id: USER_ID,
          tool_name: "create_internal_note",
          scope: "session",
          conversation_id: CONVERSATION_ID,
        },
      ]),
      { userId: USER_ID, conversationId: CONVERSATION_ID, toolName: "create_internal_note", riskLevel: "reversible" },
    );
    expect(decision.status).toBe("allowed");
  });

  it("exige une confirmation si la permission 'session' existante concerne une AUTRE conversation", async () => {
    const decision = await checkPermission(
      client([
        {
          user_id: USER_ID,
          tool_name: "create_internal_note",
          scope: "session",
          conversation_id: OTHER_CONVERSATION_ID,
        },
      ]),
      { userId: USER_ID, conversationId: CONVERSATION_ID, toolName: "create_internal_note", riskLevel: "reversible" },
    );
    expect(decision.status).toBe("requires_confirmation");
  });

  it("ignore les permissions accordées à un autre outil", async () => {
    const decision = await checkPermission(
      client([{ user_id: USER_ID, tool_name: "un_autre_outil", scope: "always", conversation_id: null }]),
      { userId: USER_ID, conversationId: CONVERSATION_ID, toolName: "create_internal_note", riskLevel: "reversible" },
    );
    expect(decision.status).toBe("requires_confirmation");
  });
});

describe("grantPermission", () => {
  it("enregistre une permission 'always' sans conversation_id", async () => {
    const fake = createFakeSupabase({ tool_permissions: [] });
    await grantPermission(fake as unknown as SupabaseClient<Database>, {
      userId: USER_ID,
      toolName: "create_internal_note",
      scope: "always",
      conversationId: CONVERSATION_ID,
    });
    const rows = fake._tables.tool_permissions ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "always", conversation_id: null });
  });

  it("enregistre une permission 'session' avec le conversation_id fourni", async () => {
    const fake = createFakeSupabase({ tool_permissions: [] });
    await grantPermission(fake as unknown as SupabaseClient<Database>, {
      userId: USER_ID,
      toolName: "create_internal_note",
      scope: "session",
      conversationId: CONVERSATION_ID,
    });
    const rows = fake._tables.tool_permissions ?? [];
    expect(rows[0]).toMatchObject({ scope: "session", conversation_id: CONVERSATION_ID });
  });
});
