// Tests unitaires des transitions d'état atomiques (confirmMemory, rejectMemory,
// editProposedMemory, deleteActiveMemory) via un client Supabase factice en mémoire.
// Prouvent la logique applicative (bon type d'erreur, bon champ, bon statut final) —
// PAS l'atomicité réelle sous concurrence, que seuls les tests d'intégration contre
// un vrai Postgres (memory-management.integration.test.ts,
// concurrency.integration.test.ts) peuvent prouver.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  confirmMemory,
  deleteActiveMemory,
  editProposedMemory,
  rejectMemory,
} from "@/core/memory-engine/index";
import { MemoryNotFoundError, MemoryStateConflictError } from "@/core/memory-engine/errors";
import { createFakeMemoryItemsClient } from "@/core/memory-engine/test-helpers/fake-supabase";
import type { Database } from "@/lib/supabase/database.types";

const USER_ID = "user-1";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    user_id: USER_ID,
    type: "profil",
    content: "Préfère voyager le matin",
    structured_content: { key: "voyage_horaire", value: "matin" },
    source_type: "explicite",
    status: "proposed",
    supersedes_id: null,
    ...overrides,
  };
}

function fakeClient(rows: ReturnType<typeof baseRow>[]) {
  return createFakeMemoryItemsClient(rows) as unknown as SupabaseClient<Database>;
}

describe("confirmMemory", () => {
  it("réussit depuis 'proposed' et passe à 'active'", async () => {
    const client = fakeClient([baseRow({ status: "proposed" })]);
    const result = await confirmMemory(client, USER_ID, "item-1");
    expect(result.status).toBe("active");
  });

  it("refuse avec un conflit honnête si déjà 'active'", async () => {
    const client = fakeClient([baseRow({ status: "active" })]);
    await expect(confirmMemory(client, USER_ID, "item-1")).rejects.toThrow(MemoryStateConflictError);
  });

  it("lève MemoryNotFoundError si le souvenir n'existe pas", async () => {
    const client = fakeClient([]);
    await expect(confirmMemory(client, USER_ID, "item-1")).rejects.toThrow(MemoryNotFoundError);
  });

  it("supersède l'ancien souvenir en best-effort quand il est encore 'active'", async () => {
    const rows = [
      baseRow({ id: "old", status: "active" }),
      baseRow({ id: "new", status: "proposed", supersedes_id: "old" }),
    ];
    const client = fakeClient(rows);
    const fake = client as unknown as { _rows: Record<string, unknown>[] };
    await confirmMemory(client, USER_ID, "new");
    const old = fake._rows.find((r) => r.id === "old");
    expect(old?.status).toBe("superseded");
  });

  it("ne fait pas échouer la confirmation si l'ancien souvenir n'est plus 'active'", async () => {
    const rows = [
      baseRow({ id: "old", status: "deleted" }),
      baseRow({ id: "new", status: "proposed", supersedes_id: "old" }),
    ];
    const client = fakeClient(rows);
    const result = await confirmMemory(client, USER_ID, "new");
    expect(result.status).toBe("active");
  });
});

describe("rejectMemory", () => {
  it("réussit depuis 'proposed' et passe à 'deleted'", async () => {
    const client = fakeClient([baseRow({ status: "proposed" })]);
    await rejectMemory(client, USER_ID, "item-1");
    const fake = client as unknown as { _rows: Record<string, unknown>[] };
    expect(fake._rows[0]?.status).toBe("deleted");
  });

  it("refuse avec un conflit honnête si déjà confirmé", async () => {
    const client = fakeClient([baseRow({ status: "active" })]);
    await expect(rejectMemory(client, USER_ID, "item-1")).rejects.toThrow(MemoryStateConflictError);
  });
});

describe("editProposedMemory", () => {
  it("réussit depuis 'proposed'", async () => {
    const client = fakeClient([baseRow({ status: "proposed" })]);
    const result = await editProposedMemory(client, USER_ID, "item-1", {
      content: "Préfère voyager tôt le matin",
      structuredContent: { key: "voyage_horaire", value: "tôt le matin" },
    });
    expect(result.content).toBe("Préfère voyager tôt le matin");
  });

  it("refuse avec un conflit honnête si la proposition a déjà été confirmée ailleurs", async () => {
    const client = fakeClient([baseRow({ status: "active" })]);
    await expect(
      editProposedMemory(client, USER_ID, "item-1", {
        content: "x",
        structuredContent: { key: "voyage_horaire", value: "x" },
      }),
    ).rejects.toThrow(MemoryStateConflictError);
  });
});

describe("deleteActiveMemory", () => {
  it("réussit depuis 'active'", async () => {
    const client = fakeClient([baseRow({ status: "active" })]);
    await deleteActiveMemory(client, USER_ID, "item-1");
    const fake = client as unknown as { _rows: Record<string, unknown>[] };
    expect(fake._rows[0]?.status).toBe("deleted");
  });

  it("refuse avec un conflit honnête si ce n'est pas encore actif", async () => {
    const client = fakeClient([baseRow({ status: "proposed" })]);
    await expect(deleteActiveMemory(client, USER_ID, "item-1")).rejects.toThrow(
      MemoryStateConflictError,
    );
  });
});
