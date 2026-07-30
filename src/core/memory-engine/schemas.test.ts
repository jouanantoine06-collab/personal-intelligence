import { describe, expect, it } from "vitest";
import { memoryCandidateSchema, parseStructuredContent } from "@/core/memory-engine/schemas";

describe("parseStructuredContent", () => {
  it("valide un contenu profil correct", () => {
    const result = parseStructuredContent("profil", { key: "voyage_horaire", value: "matin" });
    expect(result).toEqual({ key: "voyage_horaire", value: "matin" });
  });

  it("valide un contenu projet correct avec statut par défaut", () => {
    const result = parseStructuredContent("projet", { project_name: "Verdict" });
    expect(result).toMatchObject({ project_name: "Verdict", statut: "actif" });
  });

  it("rejette un contenu profil incomplet", () => {
    expect(() => parseStructuredContent("profil", { key: "voyage_horaire" })).toThrow();
  });

  it("rejette un type de mémoire inconnu au niveau du candidat", () => {
    const result = memoryCandidateSchema.safeParse({
      type: "inconnu",
      content: "x",
      structured_content: {},
      confidence: 0.5,
      importance: 0.5,
      sensitivity: "normal",
      event_date: null,
      is_explicit_request: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepte un candidat complet valide", () => {
    const result = memoryCandidateSchema.safeParse({
      type: "profil",
      content: "Préfère voyager le matin",
      structured_content: { key: "voyage_horaire", value: "matin" },
      confidence: 0.9,
      importance: 0.6,
      sensitivity: "normal",
      event_date: null,
      is_explicit_request: true,
    });
    expect(result.success).toBe(true);
  });
});
