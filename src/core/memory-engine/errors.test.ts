import { describe, expect, it } from "vitest";
import { resolveCorrectionAction } from "@/core/memory-engine/errors";

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
