import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clearRegistryForTests, getTool } from "@/core/tool-registry/index";
import { registerBuiltinTools } from "@/core/tool-registry/builtin-tools";
import { createFakeSupabase } from "@/core/test-helpers/fake-supabase";
import type { Database } from "@/lib/supabase/database.types";

const USER_ID = "user-1";

describe("outils intégrés — notes internes", () => {
  beforeEach(() => {
    clearRegistryForTests();
    registerBuiltinTools();
  });

  it("déclare list_internal_notes en 'no_risk' et create_internal_note en 'reversible'", () => {
    expect(getTool("list_internal_notes")?.riskLevel).toBe("no_risk");
    expect(getTool("create_internal_note")?.riskLevel).toBe("reversible");
  });

  it("create_internal_note rejette un contenu vide", () => {
    const tool = getTool("create_internal_note")!;
    expect(() => tool.parseInput({ content: "" })).toThrow();
  });

  it("create_internal_note valide un contenu correct", () => {
    const tool = getTool("create_internal_note")!;
    expect(tool.parseInput({ content: "Penser à relire le contrat" })).toEqual({
      content: "Penser à relire le contrat",
    });
  });

  it("create_internal_note insère bien une note pour l'utilisateur", async () => {
    const tool = getTool("create_internal_note")!;
    const fake = createFakeSupabase({ internal_notes: [] });
    const supabase = fake as unknown as SupabaseClient<Database>;

    const result = (await tool.execute(tool.parseInput({ content: "Ma note" }), {
      supabase,
      userId: USER_ID,
    })) as { content: string };

    expect(result.content).toBe("Ma note");
    const notes = fake._tables.internal_notes ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.user_id).toBe(USER_ID);
  });

  it("list_internal_notes ne retourne que les notes de l'utilisateur courant", async () => {
    const tool = getTool("list_internal_notes")!;
    const fake = createFakeSupabase({
      internal_notes: [
        { id: "n1", user_id: USER_ID, content: "à moi", created_at: "2026-01-01T00:00:00Z" },
        { id: "n2", user_id: "autre-utilisateur", content: "pas à moi", created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const supabase = fake as unknown as SupabaseClient<Database>;

    const result = (await tool.execute(tool.parseInput({}), {
      supabase,
      userId: USER_ID,
    })) as { notes: { content: string }[] };

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.content).toBe("à moi");
  });
});
