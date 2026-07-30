# ADR-0002 — Construction propre du noyau, aucun fork

## Statut
Accepté (figé).

## Contexte
Audit de trois projets open source "Jarvis" sérieux (voir `docs/research/open-source-audit.md`). Aucun ne réunit licence commerciale viable + activité de maintenance réelle + stack alignée (TypeScript/Next/Supabase).

## Décision
Le noyau (Orchestrateur, Context Engine, Memory Engine, Permission Gate, Tool Executor, Audit Journal, AI Provider) est construit intégralement en propre. Aucun fork. Réutilisation d'idées ponctuelles autorisée (ex. filtrage d'outils, détection d'echo vocal) sans réutilisation de code.

## Conséquences
Coût de développement initial plus élevé qu'un fork, mais maîtrise complète du noyau (l'actif principal du produit) et absence de dette de licence ou de dette d'intégration avec une philosophie produit étrangère.
