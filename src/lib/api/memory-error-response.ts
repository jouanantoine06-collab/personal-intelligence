import { NextResponse } from "next/server";
import {
  InvalidMemoryInputError,
  MemoryNotFoundError,
  MemoryStateConflictError,
} from "@/core/memory-engine/errors";

// Traduction honnête des erreurs du Memory Engine en réponses HTTP : aucune route
// ne doit présenter une action comme réussie si une garde-fou l'a bloquée.
export function memoryErrorResponse(error: unknown): NextResponse {
  if (error instanceof MemoryNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof MemoryStateConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof InvalidMemoryInputError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Erreur inattendue sur une route mémoire", error);
  return NextResponse.json({ error: "Une erreur inattendue est survenue." }, { status: 500 });
}
