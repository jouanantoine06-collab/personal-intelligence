// Tool Registry — permet d'enregistrer un outil sans if/else géant. Consulté par
// l'Orchestrateur (niveau de risque, description exposée à l'IA) et par le Tool
// Executor (validation d'entrée, fonction d'exécution). N'est pas un des 7
// composants figés de l'architecture : c'est une structure de support interne au
// Tool Executor, au même titre que les schémas Zod du Memory Engine.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ToolRiskLevel } from "@/lib/supabase/database.types";
import type { AIToolDefinition } from "@/core/ai-provider/types";

export interface ToolExecutionContext {
  supabase: SupabaseClient<Database>;
  userId: string;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  // Point d'extension pour les futurs connecteurs (ex. "gmail:send") — pour les
  // outils internes de la V1.1, la permission requise est simplement le nom de l'outil.
  requiredPermission: string;
  // Schéma JSON exposé au modèle de raisonnement (format attendu par AIProvider).
  aiInputSchema: Record<string, unknown>;
  // Validation stricte côté serveur — ne fait jamais confiance à l'entrée fournie par le modèle.
  parseInput: (raw: unknown) => Input;
  execute: (input: Input, context: ToolExecutionContext) => Promise<Output>;
}

const registry = new Map<string, ToolDefinition>();

// Idempotent plutôt que de lever une erreur : évite les faux positifs lors du
// rechargement à chaud en développement (le module peut être ré-exécuté sans que
// l'ancien registre ait été vidé).
export function registerTool(tool: ToolDefinition): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

export function listToolsForAI(): AIToolDefinition[] {
  return listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.aiInputSchema,
  }));
}

// Réservé aux tests : repartir d'un registre vide sans dépendre de l'ordre des imports.
export function clearRegistryForTests(): void {
  registry.clear();
}
