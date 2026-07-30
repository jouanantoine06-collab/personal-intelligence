import type { MemoryStatus } from "@/lib/supabase/database.types";

export class MemoryNotFoundError extends Error {
  constructor(memoryItemId: string) {
    super(`Souvenir introuvable: ${memoryItemId}`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryStateConflictError extends Error {
  constructor(
    public readonly action: MemoryAction,
    public readonly currentStatus: MemoryStatus,
  ) {
    super(`Action "${action}" impossible depuis le statut "${currentStatus}".`);
    this.name = "MemoryStateConflictError";
  }
}

export class InvalidMemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryInputError";
  }
}

export type MemoryAction = "confirm" | "reject" | "edit_proposed" | "correct_active" | "delete_active";

const ALLOWED_STATUS_BY_ACTION: Record<MemoryAction, readonly MemoryStatus[]> = {
  confirm: ["proposed"],
  reject: ["proposed"],
  edit_proposed: ["proposed"],
  correct_active: ["active"],
  delete_active: ["active"],
};

// Garde-fou unique et pur pour toutes les transitions d'état de la mémoire —
// aucune route ni fonction du Memory Engine ne doit dupliquer cette règle.
export function assertValidTransition(status: MemoryStatus, action: MemoryAction): void {
  if (!ALLOWED_STATUS_BY_ACTION[action].includes(status)) {
    throw new MemoryStateConflictError(action, status);
  }
}

// Décision pure utilisée par la route PATCH /api/memory/[id] pour choisir entre
// éditer une proposition en place et corriger (superséder) un souvenir actif.
export function resolveCorrectionAction(
  status: MemoryStatus,
): "edit_proposed" | "correct_active" | null {
  if (status === "proposed") {
    return "edit_proposed";
  }
  if (status === "active") {
    return "correct_active";
  }
  return null;
}
