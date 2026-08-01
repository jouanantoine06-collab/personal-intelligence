import { describe, expect, it } from "vitest";
import { resolvePendingConfirmation } from "@/core/orchestrator/confirmation";
import type { AICompletionResult, AIProvider } from "@/core/ai-provider/types";

function fakeProvider(responseText: string | null): AIProvider {
  return {
    async complete(): Promise<AICompletionResult> {
      return {
        content: responseText ? [{ type: "text", text: responseText }] : [],
        textSummary: responseText,
        toolCalls: [],
      };
    },
  };
}

describe("resolvePendingConfirmation", () => {
  it("retourne 'confirm' quand le modèle répond confirm", async () => {
    const outcome = await resolvePendingConfirmation(fakeProvider('{"outcome":"confirm"}'), {
      pendingContent: "Verdict est ta priorité",
      userMessage: "oui exactement",
    });
    expect(outcome).toBe("confirm");
  });

  it("retourne 'reject' quand le modèle répond reject", async () => {
    const outcome = await resolvePendingConfirmation(fakeProvider('{"outcome":"reject"}'), {
      pendingContent: "Verdict est ta priorité",
      userMessage: "non laisse tomber",
    });
    expect(outcome).toBe("reject");
  });

  it("retourne 'unrelated' si la réponse n'est pas un JSON valide", async () => {
    const outcome = await resolvePendingConfirmation(fakeProvider("n'importe quoi"), {
      pendingContent: "Verdict est ta priorité",
      userMessage: "quel temps fait-il ?",
    });
    expect(outcome).toBe("unrelated");
  });

  it("retourne 'confirm' même si le modèle encapsule sa réponse en ```json — bug réel observé", async () => {
    const outcome = await resolvePendingConfirmation(fakeProvider('```json\n{"outcome":"confirm"}\n```'), {
      pendingContent: "Verdict est ta priorité",
      userMessage: "Oui, confirme.",
    });
    expect(outcome).toBe("confirm");
  });

  it("retourne 'unrelated' si le modèle ne répond rien", async () => {
    const outcome = await resolvePendingConfirmation(fakeProvider(null), {
      pendingContent: "Verdict est ta priorité",
      userMessage: "quel temps fait-il ?",
    });
    expect(outcome).toBe("unrelated");
  });
});
