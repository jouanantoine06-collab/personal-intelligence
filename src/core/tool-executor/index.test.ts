import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeTool } from "@/core/tool-executor/index";
import { clearRegistryForTests, registerTool, type ToolDefinition } from "@/core/tool-registry/index";
import { createFakeSupabase } from "@/core/test-helpers/fake-supabase";
import type { Database } from "@/lib/supabase/database.types";

const USER_ID = "user-1";

function client() {
  const fake = createFakeSupabase({ audit_journal: [] });
  return { supabase: fake as unknown as SupabaseClient<Database>, fake };
}

describe("executeTool", () => {
  beforeEach(() => {
    clearRegistryForTests();
  });

  it("refuse de s'exécuter sans autorisation 'allowed' explicite — ne s'auto-autorise jamais", async () => {
    registerTool({
      name: "echo",
      description: "",
      riskLevel: "no_risk",
      requiredPermission: "echo",
      aiInputSchema: {},
      parseInput: (raw) => raw,
      execute: async (input) => input,
    } satisfies ToolDefinition);

    const { supabase } = client();
    await expect(
      executeTool(supabase, {
        userId: USER_ID,
        turnId: null,
        toolName: "echo",
        rawInput: {},
        authorization: { status: "requires_confirmation" },
      }),
    ).rejects.toThrow(/autorisation explicite/);
  });

  it("retourne 'unknown_tool' pour un outil non enregistré, et journalise l'échec", async () => {
    const { supabase, fake } = client();
    const outcome = await executeTool(supabase, {
      userId: USER_ID,
      turnId: null,
      toolName: "n_existe_pas",
      rawInput: {},
      authorization: { status: "allowed" },
    });
    expect(outcome).toEqual({ status: "unknown_tool" });
    expect(fake._tables.audit_journal).toHaveLength(1);
    expect(fake._tables.audit_journal?.[0]).toMatchObject({ event_type: "tool_execution_failed" });
  });

  it("retourne 'invalid_input' si la validation échoue, et journalise l'échec", async () => {
    registerTool({
      name: "strict_tool",
      description: "",
      riskLevel: "no_risk",
      requiredPermission: "strict_tool",
      aiInputSchema: {},
      parseInput: () => {
        throw new Error("entrée invalide");
      },
      execute: async () => ({}),
    } satisfies ToolDefinition);

    const { supabase, fake } = client();
    const outcome = await executeTool(supabase, {
      userId: USER_ID,
      turnId: null,
      toolName: "strict_tool",
      rawInput: { bad: true },
      authorization: { status: "allowed" },
    });
    expect(outcome).toEqual({ status: "invalid_input", message: "entrée invalide" });
    expect(fake._tables.audit_journal?.[0]).toMatchObject({ event_type: "tool_execution_failed" });
  });

  it("exécute l'outil et journalise le succès avec le résultat", async () => {
    registerTool({
      name: "add",
      description: "",
      riskLevel: "no_risk",
      requiredPermission: "add",
      aiInputSchema: {},
      parseInput: (raw) => raw as { a: number; b: number },
      execute: async (input) => ({ sum: input.a + input.b }),
    } satisfies ToolDefinition<{ a: number; b: number }, { sum: number }> as ToolDefinition);

    const { supabase, fake } = client();
    const outcome = await executeTool(supabase, {
      userId: USER_ID,
      turnId: "turn-1",
      toolName: "add",
      rawInput: { a: 2, b: 3 },
      authorization: { status: "allowed" },
    });

    expect(outcome).toEqual({ status: "executed", result: { sum: 5 } });
    expect(fake._tables.audit_journal?.[0]).toMatchObject({
      event_type: "tool_executed",
      turn_id: "turn-1",
    });
  });

  it("transmet honnêtement une erreur d'exécution sans la masquer, et la journalise", async () => {
    registerTool({
      name: "failing_tool",
      description: "",
      riskLevel: "no_risk",
      requiredPermission: "failing_tool",
      aiInputSchema: {},
      parseInput: (raw) => raw,
      execute: async () => {
        throw new Error("panne simulée");
      },
    } satisfies ToolDefinition);

    const { supabase, fake } = client();
    const outcome = await executeTool(supabase, {
      userId: USER_ID,
      turnId: null,
      toolName: "failing_tool",
      rawInput: {},
      authorization: { status: "allowed" },
    });

    expect(outcome).toEqual({ status: "error", message: "panne simulée" });
    expect(fake._tables.audit_journal?.[0]).toMatchObject({ event_type: "tool_execution_failed" });
  });
});
