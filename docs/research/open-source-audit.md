# Audit des projets open source existants

Réalisé avant toute décision d'architecture, via recherche web et lecture directe des dépôts (pas de survol de titres).

## Projets analysés

| Projet | Licence | Activité | Stack | Verdict |
|---|---|---|---|---|
| [isair/jarvis](https://github.com/isair/jarvis) | Gratuit usage personnel, usage commercial soumis à accord | Actif, ~1.5k★ | Python, Whisper, MCP illimité | Idées intéressantes (mémoire, filtrage d'outils) mais licence disqualifiante pour un usage commercial |
| [open-jarvis/OpenJarvis](https://github.com/open-jarvis/OpenJarvis) | Apache 2.0 | Très actif, 8.1k★, backing institutionnel | Python + Rust (Tauri), local-first | Licence permissive et projet solide, mais stack et philosophie (agents autonomes on-device) différentes de la stack cible (TypeScript/Next/Supabase) |
| [harriik/Jarvis](https://github.com/harriik/Jarvis) | MIT | Abandonné (40 commits, aucune activité récente) | Python/PyQt, face recognition | Projet étudiant, à éviter |

Aucun projet "Jarvis V6" spécifique n'a été identifié malgré recherche ciblée. À réauditer si une URL précise est fournie.

## Décision retenue

**Construction propre du noyau (mémoire, contexte, orchestrateur, permissions), sans fork.** Aucun candidat ne réunit à la fois une licence commerciale viable, une activité de maintenance réelle, et une stack alignée avec l'existant du porteur de projet (TypeScript/Next.js/Supabase/Vercel). Forker OpenJarvis (le seul candidat sérieux sur le plan licence/activité) aurait imposé une dette d'intégration supérieure au coût d'une construction propre, du fait de l'écart de stack et de philosophie produit.

Voir `docs/decisions/0002-no-fork-build-clean.md`.
