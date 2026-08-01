# ADR-0011 — Le Tool Registry n'est pas un 8ᵉ composant figé

## Statut
Accepté.

## Contexte
La V1.1 implémente enfin Permission Gate et Tool Executor (les 2 des 7 composants figés qui n'avaient jamais été exercés faute d'outil réel). Leur implémentation a besoin d'un endroit où déclarer les outils disponibles (nom, description, niveau de risque, schéma d'entrée, fonction d'exécution) sans un `if/else` géant.

## Décision
Le Tool Registry est une structure de support interne consultée par l'Orchestrateur (pour connaître le niveau de risque avant d'appeler le Gate) et par le Tool Executor (pour retrouver la fonction d'exécution et valider l'entrée) — au même titre que les schémas Zod du Memory Engine sont une structure de support du Memory Engine sans être un composant à part. Il n'ajoute aucune autorité de décision : il ne fait que répondre à des lectures (`getTool`, `listToolsForAI`). Les 7 composants figés (`docs/architecture/system-architecture.md`) restent inchangés.

## Conséquences
`registerTool` est idempotent (écrase plutôt que de lever une erreur) pour rester sûr en cas de rechargement à chaud du module en développement. Ajouter un nouvel outil ne nécessite qu'un nouvel enregistrement dans le registre, jamais de modification de l'Orchestrateur, du Permission Gate ou du Tool Executor.
