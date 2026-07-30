# ADR-0009 — Récupération mémoire V0.1 : filtrage structuré uniquement, derrière une interface `MemoryRetriever`

## Statut
Accepté.

## Contexte
`docs/architecture/memory-system.md` (figé) documente une récupération hybride (embedding + mots-clés + récence/importance), et la migration `0001_init.sql` inclut déjà une colonne `memory_items.embedding vector(1536)`. Aucun ADR n'avait pourtant choisi de fournisseur d'embedding — angle mort découvert pendant l'implémentation de la première tranche verticale, signalé avant toute décision (voir échange de validation correspondant).

## Décision
V0.1 : aucun fournisseur d'embedding. La récupération se fait par filtrage structuré (`type`, `project_id`, `status = 'active'`) combiné à une recherche plein texte PostgreSQL (`to_tsvector`) sur `content`, triée par une combinaison récence/importance/confiance.

La récupération est isolée derrière une interface `MemoryRetriever` (voir `src/core/memory-engine/retriever.ts`), consommée uniquement par le Memory Engine. Ni l'Orchestrateur ni aucun autre composant n'appelle directement l'implémentation concrète. Quand un fournisseur d'embedding sera introduit, une nouvelle implémentation de `MemoryRetriever` (ou une composition des deux) remplacera l'implémentation structurée sans modifier l'Orchestrateur ni le contrat du Memory Engine.

La colonne `embedding` reste dans le schéma, inutilisée, pour compatibilité future.

## Conséquences
Zéro dépendance externe et zéro coût récurrent en V0.1. Le point d'extension est explicite et isolé : ajouter la recherche sémantique plus tard est un ajout d'implémentation derrière une interface existante, pas une réécriture.
