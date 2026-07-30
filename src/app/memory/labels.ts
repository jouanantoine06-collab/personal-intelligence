import type { MemoryStatus, MemoryType } from "@/lib/supabase/database.types";

export const TYPE_LABELS: Record<MemoryType, string> = {
  profil: "Profil",
  projet: "Projet",
  relationnel: "Relationnel",
  episodique: "Épisodique",
  temporaire: "Temporaire",
  regles: "Règles",
};

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  proposed: "En attente de confirmation",
  active: "Actif",
  superseded: "Remplacé",
  expired: "Expiré",
  deleted: "Supprimé",
};

export const SOURCE_LABELS: Record<string, string> = {
  explicite: "Demande explicite",
  infere: "Déduit de la conversation",
  resultat_outil: "Résultat d'outil",
  importe: "Importé",
};

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR");
}
