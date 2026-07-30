# ADR-0007 — Abstraction AI Provider dès la V0.1, un seul fournisseur (Claude)

## Statut
Accepté (figé).

## Contexte
Risque de lock-in fournisseur si l'Orchestrateur appelle directement un SDK propriétaire. Mais construire un routing multi-modèle complet en V0.1 serait prématuré (aucun besoin réel de router aujourd'hui).

## Décision
Une interface `AIProvider` fine (adaptateur pur, sans logique métier) est mise en place dès la V0.1, avec une seule implémentation (Claude via le SDK Anthropic). Les appels internes au tour (extraction mémoire, classification) peuvent déjà cibler un modèle moins coûteux que le raisonnement principal (ex. Haiku vs Sonnet), même avec un seul fournisseur.

## Conséquences
Coût de maintien de l'abstraction minime (c'est un adaptateur, pas un moteur). Ajouter un second fournisseur ou un routing plus riche plus tard est un changement de configuration, pas une réécriture.
