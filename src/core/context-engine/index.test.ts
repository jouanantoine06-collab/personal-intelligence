import { describe, it, expect } from "vitest";
import { createFakeSupabase } from "@/core/test-helpers/fake-supabase";
import { getContextState, upsertContextState } from "@/core/context-engine/index";

describe("Context Engine — fuseau horaire (V1.3b)", () => {
  it("initialise timezone à null tant que l'utilisateur ne l'a pas configuré", async () => {
    const supabase = createFakeSupabase({ context_state: [] }) as never;
    const state = await getContextState(supabase, "user-1");
    expect(state.timezone).toBeNull();
  });

  it("persiste une mise à jour du timezone", async () => {
    const supabase = createFakeSupabase({ context_state: [] }) as never;
    const state = await getContextState(supabase, "user-1");

    await upsertContextState(supabase, { ...state, timezone: "Europe/Paris" });

    const reloaded = await getContextState(supabase, "user-1");
    expect(reloaded.timezone).toBe("Europe/Paris");
  });

  it("le Context Engine renvoie exactement le timezone stocké, sans le transformer", async () => {
    const supabase = createFakeSupabase({
      context_state: [
        {
          user_id: "user-1",
          active_project_id: null,
          active_task: null,
          confidence: 0.5,
          pending_confirmations: [],
          last_device: null,
          last_modality: null,
          timezone: "America/New_York",
        },
      ],
    }) as never;

    const state = await getContextState(supabase, "user-1");
    expect(state.timezone).toBe("America/New_York");
  });
});
