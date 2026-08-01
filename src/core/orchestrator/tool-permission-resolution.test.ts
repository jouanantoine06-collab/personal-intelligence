import { describe, expect, it } from "vitest";
import { resolveToolPermissionResponse } from "@/core/orchestrator/tool-permission-resolution";
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

describe("resolveToolPermissionResponse", () => {
  it.each([
    ["once", '{"outcome":"once"}'],
    ["session", '{"outcome":"session"}'],
    ["always", '{"outcome":"always"}'],
    ["deny", '{"outcome":"deny"}'],
  ] as const)("retourne '%s' quand le modèle répond %s", async (expected, response) => {
    const outcome = await resolveToolPermissionResponse(fakeProvider(response), {
      toolName: "create_internal_note",
      userMessage: "peu importe",
    });
    expect(outcome).toBe(expected);
  });

  it("retourne 'always' même encapsulé en ```json — même bug réel que pour la mémoire", async () => {
    const outcome = await resolveToolPermissionResponse(
      fakeProvider('```json\n{"outcome":"always"}\n```'),
      { toolName: "create_internal_note", userMessage: "oui, toujours" },
    );
    expect(outcome).toBe("always");
  });

  it("retourne 'unrelated' pour une réponse hors JSON", async () => {
    const outcome = await resolveToolPermissionResponse(fakeProvider("autre chose"), {
      toolName: "create_internal_note",
      userMessage: "quel temps fait-il ?",
    });
    expect(outcome).toBe("unrelated");
  });

  it("retourne 'unrelated' si le modèle ne répond rien", async () => {
    const outcome = await resolveToolPermissionResponse(fakeProvider(null), {
      toolName: "create_internal_note",
      userMessage: "quel temps fait-il ?",
    });
    expect(outcome).toBe("unrelated");
  });
});
