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

Le schéma initial se trouve dans `supabase/migrations/`. À appliquer via le CLI Supabase ou l'éditeur SQL du projet Supabase.

## Documentation

- `docs/vision/product-vision.md` — vision produit
- `docs/research/open-source-audit.md` — audit open source
- `docs/architecture/system-architecture.md` — architecture de référence (figée)
- `docs/architecture/memory-system.md` — détail du système de mémoire
- `docs/security/threat-model.md` — modèle de menaces
- `docs/roadmap/roadmap.md` — roadmap indicative
- `docs/decisions/` — ADR
