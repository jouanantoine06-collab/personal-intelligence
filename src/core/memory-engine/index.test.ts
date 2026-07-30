import { describe, expect, it } from "vitest";
import { classifyCandidate } from "@/core/memory-engine/index";
import type { MemoryCandidate } from "@/core/memory-engine/schemas";

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    type: "profil",
    content: "Préfère voyager le matin",
    structured_content: { key: "voyage_horaire", value: "matin" },
    confidence: 0.9,
    importance: 0.6,
    sensitivity: "normal",
    event_date: null,
    is_explicit_request: true,
    ...overrides,
  };
}

describe("classifyCandidate (ADR-0008 : aucun auto-stockage en V0.1)", () => {
  it("propose toujours une confirmation, quelle que soit la sensibilité", () => {
    expect(classifyCandidate(makeCandidate({ sensitivity: "public" }))).toBe("propose");
    expect(classifyCandidate(makeCandidate({ sensitivity: "sensible" }))).toBe("propose");
  });

  it("propose toujours une confirmation, que la demande soit explicite ou inférée", () => {
    expect(classifyCandidate(makeCandidate({ is_explicit_request: true }))).toBe("propose");
    expect(classifyCandidate(makeCandidate({ is_explicit_request: false }))).toBe("propose");
  });

  it("propose toujours une confirmation, quelle que soit la confiance", () => {
    expect(classifyCandidate(makeCandidate({ confidence: 0.99 }))).toBe("propose");
    expect(classifyCandidate(makeCandidate({ confidence: 0.1 }))).toBe("propose");
  });
});
