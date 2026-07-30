"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { MemoryDetail } from "@/core/memory-engine/index";
import { SOURCE_LABELS, STATUS_LABELS, TYPE_LABELS, formatDate } from "@/app/memory/labels";

export function MemoryDetailView({ detail }: { detail: MemoryDetail }) {
  const router = useRouter();
  const { item } = detail;
  const isEditable = item.status === "proposed" || item.status === "active";

  const [content, setContent] = useState(item.content);
  const [structuredContentText, setStructuredContentText] = useState(
    JSON.stringify(item.structuredContent, null, 2),
  );
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSave() {
    setIsPending(true);
    setError(null);
    setSuccessMessage(null);

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
      const body = (await response.json()) as { item?: { id: string }; error?: string };
      if (!response.ok) {
        setError(body.error ?? "Correction impossible.");
        return;
      }

      if (item.status === "active" && body.item && body.item.id !== item.id) {
        // Correction d'un souvenir actif : une nouvelle ligne a été créée, l'ancienne
        // est désormais "superseded" — on navigue vers la nouvelle version.
        router.push(`/memory/${body.item.id}`);
        return;
      }

      setSuccessMessage("Correction enregistrée.");
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Supprimer définitivement ce souvenir de la mémoire active ?")) {
      return;
    }

    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/memory/${item.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Suppression impossible.");
        return;
      }
      router.push("/memory");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <article>
      <h1>
        [{TYPE_LABELS[item.type]}] {item.content}
      </h1>
      <p>Statut : {STATUS_LABELS[item.status]}</p>
      <dl>
        <dt>Créé le</dt>
        <dd>{formatDate(item.createdAt)}</dd>
        <dt>Provenance</dt>
        <dd>{SOURCE_LABELS[item.sourceType]}</dd>
        <dt>Confiance</dt>
        <dd>{Math.round(item.confidence * 100)}%</dd>
        <dt>Importance</dt>
        <dd>{Math.round(item.importance * 100)}%</dd>
        <dt>Sensibilité</dt>
        <dd>{item.sensitivity}</dd>
        {item.projectLabel ? (
          <>
            <dt>Projet associé</dt>
            <dd>{item.projectLabel}</dd>
          </>
        ) : null}
      </dl>

      <section>
        <h2>Contenu structuré</h2>
        <pre>{JSON.stringify(item.structuredContent, null, 2)}</pre>
      </section>

      {detail.originatingMessages ? (
        <section>
          <h2>Origine de ce souvenir</h2>
          {detail.originatingMessages.userMessage ? (
            <p>
              <strong>Message utilisateur :</strong> {detail.originatingMessages.userMessage}
            </p>
          ) : null}
          {detail.originatingMessages.assistantMessage ? (
            <p>
              <strong>Réponse de l&apos;assistant :</strong>{" "}
              {detail.originatingMessages.assistantMessage}
            </p>
          ) : null}
        </section>
      ) : null}

      {detail.supersedes ? (
        <p>
          Ce souvenir remplace :{" "}
          <Link href={`/memory/${detail.supersedes.id}`}>{detail.supersedes.content}</Link>
        </p>
      ) : null}
      {detail.supersededBy ? (
        <p>
          Ce souvenir a été remplacé par :{" "}
          <Link href={`/memory/${detail.supersededBy.id}`}>{detail.supersededBy.content}</Link>
        </p>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
      {successMessage ? <p>{successMessage}</p> : null}

      {isEditable ? (
        <section>
          <h2>Corriger</h2>
          <label>
            Contenu
            <input value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
          <label>
            Contenu structuré (JSON)
            <textarea
              value={structuredContentText}
              onChange={(e) => setStructuredContentText(e.target.value)}
              rows={6}
            />
          </label>
          <button type="button" onClick={handleSave} disabled={isPending}>
            Enregistrer la correction
          </button>
        </section>
      ) : (
        <p>
          <em>Ce souvenir (statut « {STATUS_LABELS[item.status]} ») ne peut plus être modifié.</em>
        </p>
      )}

      {item.status === "active" ? (
        <button type="button" onClick={handleDelete} disabled={isPending}>
          Supprimer
        </button>
      ) : null}
    </article>
  );
}
