# Personal Intelligence OS

Nom technique provisoire. Voir `docs/vision/product-vision.md`.

## Architecture

L'architecture du noyau (Orchestrateur, Context Engine, Memory Engine, AI Provider, Permission Gate, Tool Executor, Audit Journal) est figée et documentée dans `docs/architecture/system-architecture.md`. Toute évolution doit être justifiée par un besoin concret rencontré en développement — voir `docs/decisions/` pour l'historique des choix.

## Stack (V0.1)

Next.js (App Router, TypeScript strict), Supabase (Postgres + pgvector + Auth), Claude (Anthropic SDK) derrière une abstraction `AIProvider`. Une seule application, pas de monorepo (ADR-0001).

## Installation

```
npm install
cp .env.example .env.local   # renseigner les clés Supabase et Anthropic
npm run dev
```

## Base de données

Le schéma initial se trouve dans `supabase/migrations/`. À appliquer via le CLI Supabase ou l'éditeur SQL du projet Supabase. Nécessite un projet Supabase réel (auth email/mot de passe activée) et une clé `ANTHROPIC_API_KEY` pour fonctionner de bout en bout — non testé manuellement dans cet environnement de développement (aucun projet Supabase/Anthropic provisionné ici).

## Première tranche verticale (V0.1)

Authentification (email/mot de passe), création de conversation, envoi/réception de messages, mémorisation explicite avec confirmation obligatoire (ADR-0008), récupération de mémoire par filtrage structuré (ADR-0009), journalisation de toutes les décisions. Voir `src/core/` pour l'implémentation de l'Orchestrateur, du Context Engine, du Memory Engine, de l'AI Provider et de l'Audit Journal.

Non inclus dans cette tranche (hors scope demandé) : Permission Gate et Tool Executor (aucun outil réel dans ce périmètre), interface de consultation/suppression de la mémoire, mise à jour automatique du focus (`active_project_id`).

```
npm run typecheck
npm run lint
npm test
npm run build
```

## Documentation

- `docs/vision/product-vision.md` — vision produit
- `docs/research/open-source-audit.md` — audit open source
- `docs/architecture/system-architecture.md` — architecture de référence (figée)
- `docs/architecture/memory-system.md` — détail du système de mémoire
- `docs/security/threat-model.md` — modèle de menaces
- `docs/roadmap/roadmap.md` — roadmap indicative
- `docs/decisions/` — ADR
