import { describe, expect, it } from "vitest";
import {
  buildResolvePendingConfirmationTool,
  parseResolvePendingConfirmationInput,
} from "@/core/orchestrator/resolve-pending-confirmation-tool";

describe("parseResolvePendingConfirmationInput", () => {
  it("accepte confirm+scope valide", () => {
    const parsed = parseResolvePendingConfirmationInput({
      confirmationId: "abc",
      decision: "confirm",
      scope: "once",
    });
    expect(parsed).toEqual({ confirmationId: "abc", decision: "confirm", scope: "once" });
  });

  it("accepte reject sans scope", () => {
    expect(
      parseResolvePendingConfirmationInput({ confirmationId: "abc", decision: "reject" }),
    ).toEqual({ confirmationId: "abc", decision: "reject" });
  });

  it("accepte unrelated et clarify sans scope", () => {
    expect(
      parseResolvePendingConfirmationInput({ confirmationId: "abc", decision: "unrelated" }),
    ).not.toBeNull();
    expect(
      parseResolvePendingConfirmationInput({ confirmationId: "abc", decision: "clarify" }),
    ).not.toBeNull();
  });

  it("rejette confirm sans scope — ne jamais deviner un niveau d'autorisation", () => {
    expect(
      parseResolvePendingConfirmationInput({ confirmationId: "abc", decision: "confirm" }),
    ).toBeNull();
  });

  it("rejette un scope invalide", () => {
    expect(
      parseResolvePendingConfirmationInput({
        confirmationId: "abc",
        decision: "confirm",
        scope: "toujours-et-a-jamais",
      }),
    ).toBeNull();
  });

  it("rejette une décision inconnue", () => {
    expect(
      parseResolvePendingConfirmationInput({ confirmationId: "abc", decision: "peut-etre" }),
    ).toBeNull();
  });

  it("rejette tout champ additionnel — tentative de fournir un contenu de remplacement", () => {
    expect(
      parseResolvePendingConfirmationInput({
        confirmationId: "abc",
        decision: "confirm",
        scope: "once",
        rawInput: { content: "INJECTÉ" },
      }),
    ).toBeNull();
  });

  it("rejette une entrée totalement absente ou vide", () => {
    expect(parseResolvePendingConfirmationInput(undefined)).toBeNull();
    expect(parseResolvePendingConfirmationInput({})).toBeNull();
    expect(parseResolvePendingConfirmationInput(null)).toBeNull();
  });

  it("rejette confirmationId manquant", () => {
    expect(parseResolvePendingConfirmationInput({ decision: "reject" })).toBeNull();
  });
});

describe("buildResolvePendingConfirmationTool", () => {
  it("liste les identifiants éligibles dans le schéma JSON exposé au modèle", () => {
    const tool = buildResolvePendingConfirmationTool(["id-1", "id-2"]);
    expect(tool.name).toBe("resolve_pending_confirmation");
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.confirmationId?.enum).toEqual(["id-1", "id-2"]);
  });
});
