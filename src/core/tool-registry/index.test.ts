import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRegistryForTests,
  getTool,
  listTools,
  listToolsForAI,
  registerTool,
  type ToolDefinition,
} from "@/core/tool-registry/index";

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "fake_tool",
    description: "Un outil de test.",
    riskLevel: "no_risk",
    requiredPermission: "fake_tool",
    aiInputSchema: { type: "object", properties: {} },
    parseInput: (raw) => raw,
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("Tool Registry", () => {
  beforeEach(() => {
    clearRegistryForTests();
  });

  it("enregistre puis retrouve un outil par son nom", () => {
    registerTool(fakeTool());
    expect(getTool("fake_tool")?.description).toBe("Un outil de test.");
  });

  it("retourne undefined pour un outil non enregistré", () => {
    expect(getTool("inconnu")).toBeUndefined();
  });

  it("liste tous les outils enregistrés", () => {
    registerTool(fakeTool({ name: "a" }));
    registerTool(fakeTool({ name: "b" }));
    expect(listTools().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("est idempotent : un second enregistrement du même nom remplace le premier sans lever d'erreur", () => {
    registerTool(fakeTool({ description: "v1" }));
    expect(() => registerTool(fakeTool({ description: "v2" }))).not.toThrow();
    expect(getTool("fake_tool")?.description).toBe("v2");
  });

  it("expose aux outils IA uniquement nom/description/schéma, jamais la fonction d'exécution", () => {
    registerTool(fakeTool());
    const aiTools = listToolsForAI();
    expect(aiTools).toEqual([
      { name: "fake_tool", description: "Un outil de test.", inputSchema: { type: "object", properties: {} } },
    ]);
  });
});
