"use client";

import Link from "next/link";
import { useState } from "react";
import type { MemoryItemWithProjectLabel } from "@/core/memory-engine/index";
import type { MemoryStatus, MemoryType } from "@/lib/supabase/database.types";
import { SOURCE_LABELS, STATUS_LABELS, TYPE_LABELS, formatDate } from "@/app/memory/labels";

interface Project {
  id: string;
  label: string;
}

interface Filters {
  type: MemoryType | "";
  projectId: string;
  status: MemoryStatus | "";
  q: string;
}

const ALL_TYPES: MemoryType[] = [
  "profil",
  "projet",
  "relationnel",
  "episodique",
  "temporaire",
  "regles",
];
const ALL_STATUSES: MemoryStatus[] = ["active", "proposed", "superseded", "expired", "deleted"];

async function fetchMemoryItems(filters: Filters): Promise<MemoryItemWithProjectLabel[]> {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);

  const response = await fetch(`/api/memory?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Impossible de charger les souvenirs.");
  }
  const body = (await response.json()) as { items: MemoryItemWithProjectLabel[] };
  return body.items;
}

function PendingProposalRow({
  item,
  onResolved,
}: {
  item: MemoryItemWithProjectLabel;
  onResolved: (id: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState(item.content);
  const [structuredContentText, setStructuredContentText] = useState(
    JSON.stringify(item.structuredContent, null, 2),
  );
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/memory/${item.id}/confirm`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Confirmation impossible.");
        return;
      }
      onResolved(item.id);
    } finally {
      setIsPending(false);
    }
  }

  async function handleReject() {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/memory/${item.id}/reject`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Refus impossible.");
        return;
      }
      onResolved(item.id);
    } finally {
      setIsPending(false);
    }
  }

  async function handleSaveEdit() {
    setIsPending(true);
    setError(null);
    let parsedStructuredContent: Record<string, unknown>;
    try {
      parsedStructuredContent = JSON.parse(structuredContentText) as Record<string, unknown>;
    } catch {
      setError("Le contenu structuré doit être un JSON valide.");
      setIsPending(false);
      return;
    }

    try {
      const response = await fetch(`/api/memory/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, structuredContent: parsedStructuredContent }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Correction impossible.");
        return;
      }
      setIsEditing(false);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <li>
      <p>
        <strong>[{TYPE_LABELS[item.type]}]</strong> {isEditing ? null : item.content}
      </p>
      {isEditing ? (
        <div>
          <label>
            Contenu
            <input value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
          <label>
            Contenu structuré (JSON)
            <textarea
              value={structuredContentText}
              onChange={(e) => setStructuredContentText(e.target.value)}
              rows={4}
            />
          </label>
          <button type="button" onClick={handleSaveEdit} disabled={isPending}>
            Enregistrer la correction
          </button>
          <button type="button" onClick={() => setIsEditing(false)} disabled={isPending}>
            Annuler
          </button>
        </div>
      ) : null}
      <p>
        <small>
          Proposé le {formatDate(item.createdAt)} — {SOURCE_LABELS[item.sourceType]}
        </small>
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {!isEditing ? (
        <div>
          <button type="button" onClick={handleAccept} disabled={isPending}>
            Accepter
          </button>
          <button type="button" onClick={() => setIsEditing(true)} disabled={isPending}>
            Modifier
          </button>
          <button type="button" onClick={handleReject} disabled={isPending}>
            Refuser
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function MemoryDashboard({
  initialActiveItems,
  initialPendingItems,
  availableProjects,
}: {
  initialActiveItems: MemoryItemWithProjectLabel[];
  initialPendingItems: MemoryItemWithProjectLabel[];
  availableProjects: Project[];
}) {
  const [items, setItems] = useState(initialActiveItems);
  const [pendingItems, setPendingItems] = useState(initialPendingItems);
  const [filters, setFilters] = useState<Filters>({ type: "", projectId: "", status: "", q: "" });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyFilters(nextFilters: Filters) {
    setFilters(nextFilters);
    setIsLoading(true);
    setError(null);
    try {
      const results = await fetchMemoryItems({ ...nextFilters, status: nextFilters.status || "active" });
      setItems(results);
    } catch {
      setError("Impossible de charger les souvenirs.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleProposalResolved(id: string) {
    setPendingItems((current) => current.filter((item) => item.id !== id));
  }

  return (
    <div>
      <section>
        <h2>Propositions en attente ({pendingItems.length})</h2>
        {pendingItems.length === 0 ? (
          <p>Aucune proposition en attente.</p>
        ) : (
          <ul>
            {pendingItems.map((item) => (
              <PendingProposalRow key={item.id} item={item} onResolved={handleProposalResolved} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Souvenirs</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void applyFilters(filters);
          }}
        >
          <label>
            Type
            <select
              value={filters.type}
              onChange={(e) => void applyFilters({ ...filters, type: e.target.value as MemoryType | "" })}
            >
              <option value="">Tous</option>
              {ALL_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Projet
            <select
              value={filters.projectId}
              onChange={(e) => void applyFilters({ ...filters, projectId: e.target.value })}
            >
              <option value="">Tous</option>
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Statut
            <select
              value={filters.status}
              onChange={(e) => void applyFilters({ ...filters, status: e.target.value as MemoryStatus | "" })}
            >
              <option value="active">Actif</option>
              {ALL_STATUSES.filter((s) => s !== "active").map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Recherche
            <input
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Rechercher dans le contenu..."
            />
          </label>
          <button type="submit" disabled={isLoading}>
            Filtrer
          </button>
        </form>

        {error ? <p role="alert">{error}</p> : null}
        {isLoading ? <p>Chargement...</p> : null}

        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <Link href={`/memory/${item.id}`}>
                <strong>[{TYPE_LABELS[item.type]}]</strong> {item.content}
              </Link>
              <p>
                <small>
                  {formatDate(item.createdAt)} · confiance {Math.round(item.confidence * 100)}% ·
                  importance {Math.round(item.importance * 100)}% · {SOURCE_LABELS[item.sourceType]}
                  {item.projectLabel ? ` · projet : ${item.projectLabel}` : ""} ·{" "}
                  {STATUS_LABELS[item.status]}
                </small>
              </p>
            </li>
          ))}
        </ul>
        {items.length === 0 && !isLoading ? <p>Aucun souvenir pour ces filtres.</p> : null}
      </section>
    </div>
  );
}
