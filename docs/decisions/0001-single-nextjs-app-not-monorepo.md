# ADR-0001 — Une seule app Next.js pour la V0.1, pas de monorepo

## Statut
Accepté (figé).

## Contexte
L'arborescence monorepo complète (apps/services/packages/skills) est adaptée à un produit multi-device mature (V0.6+), pas à une V0.1 qui n'a qu'un seul client (web).

## Décision
La V0.1 est une seule application Next.js (App Router, TypeScript strict) avec Supabase. Le découpage en services/packages n'intervient que lorsqu'un besoin technique réel l'impose (ex. un service temps réel pour la voix en V0.2).

## Conséquences
Développement plus rapide et plus simple à maintenir pour la V0.1. Un refactor de structure sera nécessaire quand un deuxième déploiement/service réel apparaîtra — accepté consciemment.
