# ADR-0004 — Un seul contexte actif par utilisateur (pas de pile, pas de clé par device)

## Statut
Accepté pour la V0.1 (dette assumée documentée).

## Contexte
Un utilisateur pourrait interrompre une tâche pour une question rapide puis reprendre ("focus stack"), et pourrait utiliser plusieurs devices simultanément sur des sujets différents.

## Décision
V0.1 : une seule ligne `context_state` par `user_id`, écrasée en place. Le schéma prévoit `status` et `previous_context_id` pour permettre une pile plus tard sans migration douloureuse, mais aucune pile n'est implémentée.

## Conséquences
Risque assumé et documenté : usage concurrent multi-device réel provoquerait une contamination de contexte entre appareils. Accepté car la V0.1 n'a qu'un seul client (web) — aucun scénario concurrent réel n'existe encore. À trancher explicitement (clé `user_id` seul vs `user_id + device/thread`) avant V0.6 (desktop, deuxième client actif).
