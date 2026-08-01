import { describe, expect, it } from "vitest";
import { classifyCandidate, extractCandidate } from "@/core/memory-engine/index";
import type { MemoryCandidate } from "@/core/memory-engine/schemas";
import type { AICompletionResult, AIProvider } from "@/core/ai-provider/types";

function fakeProvider(responseText: string): AIProvider {
  return {
    async complete(): Promise<AICompletionResult> {
      return { content: [{ type: "text", text: responseText }], textSummary: responseText, toolCalls: [] };
    },
  };
}

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

describe("extractCandidate — robustesse face aux réponses réelles du modèle d'extraction", () => {
  const validPayload = {
    type: "projet",
    content: "Verdict est la priorité actuelle",
    structured_content: { project_name: "Verdict", statut: "actif" },
    confidence: 0.9,
    importance: 0.8,
    sensitivity: "normal",
    event_date: null,
  };

  it("accepte un JSON brut sans balise", async () => {
    const candidate = await extractCandidate(fakeProvider(JSON.stringify(validPayload)), "x", true);
    expect(candidate?.content).toBe("Verdict est la priorité actuelle");
  });

  it("accepte un JSON encapsulé dans une balise ```json — bug réel observé avec Haiku", async () => {
    const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
    const candidate = await extractCandidate(fakeProvider(fenced), "x", true);
    expect(candidate?.content).toBe("Verdict est la priorité actuelle");
  });

  it("accepte un JSON encapsulé dans une balise ``` sans langage", async () => {
    const fenced = "```\n" + JSON.stringify(validPayload) + "\n```";
    const candidate = await extractCandidate(fakeProvider(fenced), "x", true);
    expect(candidate).not.toBeNull();
  });

  it("retombe sur 'actif' si le modèle renvoie une valeur de statut hors énumération — bug réel observé", async () => {
    const payload = {
      ...validPayload,
      structured_content: { project_name: "Verdict", statut: "priorité actuelle" },
    };
    const candidate = await extractCandidate(fakeProvider(JSON.stringify(payload)), "x", true);
    expect(candidate?.structured_content.statut).toBe("actif");
  });

  it("retourne null pour un JSON réellement invalide", async () => {
    const candidate = await extractCandidate(fakeProvider("ceci n'est pas du JSON"), "x", true);
    expect(candidate).toBeNull();
  });
});
