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

Non inclus dans cette tranche (hors scope demandé) : Permission Gate et Tool Executor (aucun outil réel dans ce périmètre — implémentés en V1.1, voir plus bas), mise à jour automatique du focus (`active_project_id`).

## Deuxième tranche verticale (contrôle utilisateur de la mémoire)

Interface complète `/memory` : liste filtrable (type/projet/statut/recherche plein texte), propositions en attente (accepter/modifier/refuser), page de détail par souvenir (provenance, message d'origine, chaîne de supersession), correction (édition en place pour une proposition, nouvelle version + supersession pour un souvenir actif), suppression (soft-delete). Voir `src/core/memory-engine/index.ts` (nouvelles fonctions) et `src/core/memory-engine/errors.ts` (garde-fous de transition d'état).

### Tests d'intégration RLS/isolation

`src/core/memory-engine/memory-management.integration.test.ts` nécessite un vrai projet Supabase (local via `supabase start`, ou un projet distant dédié aux tests) — jamais un projet de production, ce fichier crée et supprime de vrais utilisateurs de test. Variables requises :

```
SUPABASE_TEST_URL=...
SUPABASE_TEST_ANON_KEY=...
SUPABASE_TEST_SERVICE_ROLE_KEY=...
```

`src/core/memory-engine/concurrency.integration.test.ts` utilise les mêmes variables et prouve, contre un vrai Postgres, qu'aucune transition d'état (confirm/reject/delete) ne peut réussir en double sous concurrence (voir ADR-0010).

Sans ces variables, ces suites sont automatiquement ignorées (`describe.skipIf`) — c'est le cas dans cet environnement de développement.

```
npm run typecheck
npm run lint
npm test
npm run build
```

## Tranche de validation en conditions réelles

Provisionnement effectué sur un vrai projet Supabase (migrations 0001+0002 appliquées, schéma vérifié), parcours auth/chat/mémoire testés pour de vrai (navigateur headless réel via Playwright + vraie API Claude), tests RLS et de concurrence exécutés contre le vrai projet. Bugs réels trouvés et corrigés à cette occasion :

- middleware jamais exécuté (mauvais emplacement du fichier avec une structure `src/`) — toutes les pages étaient accessibles sans authentification ;
- redirection HTML des routes `/api/*` par le middleware au lieu d'un 401 JSON ;
- réponses JSON de Claude/Haiku parfois encapsulées en ```` ```json ```` malgré la consigne contraire, cassant l'extraction de candidat mémoire et la classification de confirmation (`src/core/ai-provider/parse-json-response.ts`) ;
- race condition réelle sur les transitions d'état mémoire, corrigée par écriture conditionnelle atomique (ADR-0010).

### Scripts de validation (`scripts/`)

Non couverts par `npm test` (nécessitent un vrai projet Supabase/Anthropic configuré dans `.env.local`) :
- `check-schema.mjs` — vérifie que le schéma réel correspond aux migrations.
- `check-audit-journal.mjs <email>` — affiche les événements journalisés pour un utilisateur.
- `run-rls-integration-tests.mjs` / `run-concurrency-integration-tests.mjs` / `run-integration-tests.mjs <pattern>` — exécutent les suites d'intégration en réutilisant les identifiants du projet de dev comme `SUPABASE_TEST_*` (aucun second projet dédié provisionné).
- `e2e-validation.mjs` — parcours navigateur réel (Playwright) : auth, chat avec Claude, mémorisation, confirmation, refus, correction, suppression.
- `e2e-tools-validation.mjs` — parcours navigateur réel pour les outils (V1.1) : liste/création de notes, cycle d'autorisation once/session/always.
- `cleanup-test-users.mjs` — supprime les utilisateurs de test créés par ces scripts.

## V1.1 — infrastructure d'outils

Permission Gate, Tool Registry et Tool Executor implémentés pour de vrai (les deux premiers étaient dans l'architecture figée depuis le début mais jamais exercés faute d'outil). Premier outil de démonstration : notes internes (`list_internal_notes` en lecture sans confirmation, `create_internal_note` nécessitant une autorisation une fois/session/toujours). Voir `docs/architecture/tool-system.md` pour le détail, et `docs/decisions/0011-*` / `0012-*` pour les décisions.

Deux bugs réels trouvés et corrigés via tests en conditions réelles (navigateur réel + vrai Claude), au-delà de ce qu'un test scripté aurait pu révéler :
- un même outil pouvait être rappelé deux fois dans un même tour, empilant deux confirmations distinctes ;
- une confirmation non résolue immédiatement pouvait être résolue par erreur par un message ultérieur sans rapport, exécutant une ancienne demande à la place de la nouvelle.

Corrigés par un dédoublonnage intra-tour déterministe et une expiration stricte inter-tour (ADR-0012) — limite résiduelle documentée et assumée : le classifieur de résolution peut encore, rarement, mal classer un nouveau sujet ; une amélioration (résolution portée par le modèle principal) est prévue pour une prochaine tranche, sans bloquer celle-ci.

## V1.2 — résolution des confirmations pilotée par le modèle principal

Le classifieur isolé (`resolveToolPermissionResponse`, un appel Haiku séparé ne voyant que le contenu en attente + le dernier message) est **supprimé**. Remplacé par un outil structuré (`resolve_pending_confirmation`) proposé au modèle de raisonnement principal — avec tout l'historique de conversation — uniquement quand une confirmation est éligible pour la conversation courante. Décision en 4 valeurs (`confirm`+scope obligatoire, `reject`, `unrelated`, `clarify`), schéma strict (le modèle ne peut jamais fournir de contenu de remplacement), expiration désormais exhaustive (sortie invalide/ambiguë/absente/erreur de modèle → toujours expirée, jamais exécutée). Voir ADR-0013.

`src/core/orchestrator/tool-flow.integration.test.ts` couvre, contre un vrai Supabase, 20 tests dont les 15 cas demandés (réponse immédiate, "une fois", "toujours", refus, annulation, ambiguïté, nouveau sujet, aparté puis réponse tardive, tentative de modification du payload, injection de prompt, confirmation expirée, absence de confirmation en attente, deux confirmations simultanées, réponse courte simulée, erreur/timeout du modèle).

Un smoke test réel (navigateur + vrai Claude), reproduisant exactement le scénario qui échouait sous l'ancien mécanisme (nouveau sujet après confirmation en attente), montre sur deux exécutions consécutives le modèle appeler correctement `resolve_pending_confirmation` avec `decision:"unrelated"` — aucune fausse confirmation observée.

## Documentation

- `docs/vision/product-vision.md` — vision produit
- `docs/research/open-source-audit.md` — audit open source
- `docs/architecture/system-architecture.md` — architecture de référence (figée)
- `docs/architecture/memory-system.md` — détail du système de mémoire
- `docs/security/threat-model.md` — modèle de menaces
- `docs/roadmap/roadmap.md` — roadmap indicative
- `docs/decisions/` — ADR
