import { describe, expect, it } from "vitest";
import {
  assertValidTransition,
  MemoryStateConflictError,
  resolveCorrectionAction,
} from "@/core/memory-engine/errors";
import type { MemoryStatus } from "@/lib/supabase/database.types";
import type { MemoryAction } from "@/core/memory-engine/errors";

const ALL_STATUSES: MemoryStatus[] = ["proposed", "active", "superseded", "expired", "deleted"];
const ALL_ACTIONS: MemoryAction[] = [
  "confirm",
  "reject",
  "edit_proposed",
  "correct_active",
  "delete_active",
];

const EXPECTED_ALLOWED: Record<MemoryAction, MemoryStatus> = {
  confirm: "proposed",
  reject: "proposed",
  edit_proposed: "proposed",
  correct_active: "active",
  delete_active: "active",
};

describe("assertValidTransition", () => {
  for (const action of ALL_ACTIONS) {
    for (const status of ALL_STATUSES) {
      const shouldAllow = EXPECTED_ALLOWED[action] === status;

      it(`${shouldAllow ? "autorise" : "refuse"} "${action}" depuis le statut "${status}"`, () => {
        if (shouldAllow) {
          expect(() => assertValidTransition(status, action)).not.toThrow();
        } else {
          expect(() => assertValidTransition(status, action)).toThrow(MemoryStateConflictError);
        }
      });
    }
  }

  it("porte l'action et le statut sur l'erreur pour un mapping HTTP propre", () => {
    try {
      assertValidTransition("active", "confirm");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryStateConflictError);
      const conflict = error as MemoryStateConflictError;
      expect(conflict.action).toBe("confirm");
      expect(conflict.currentStatus).toBe("active");
    }
  });
});

describe("resolveCorrectionAction", () => {
  it("route un souvenir 'proposed' vers l'édition en place", () => {
    expect(resolveCorrectionAction("proposed")).toBe("edit_proposed");
  });

  it("route un souvenir 'active' vers la correction avec supersession", () => {
    expect(resolveCorrectionAction("active")).toBe("correct_active");
  });

  it("ne permet aucune correction pour les statuts terminaux ou remplacés", () => {
    expect(resolveCorrectionAction("superseded")).toBeNull();
    expect(resolveCorrectionAction("expired")).toBeNull();
    expect(resolveCorrectionAction("deleted")).toBeNull();
  });
});
