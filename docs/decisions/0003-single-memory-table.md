# ADR-0003 — Table mémoire unique (`memory_items`)

## Statut
Accepté (figé).

## Contexte
Six types de mémoire (profil, projet, relationnel, épisodique, temporaire, règles) pourraient être modélisés en six tables séparées ou une table unique discriminée par type.

## Décision
Une seule table `memory_items`, colonne `type` discriminante, `structured_content` en JSONB validé par schéma Zod par type. Tout champ utilisé pour filtrer/trier/joindre est promu en vraie colonne indexée (jamais laissé dans le JSONB).

## Conséquences
Requêtes transverses simplifiées (les faits croisent souvent plusieurs types). Perte de contrainte au niveau base de données sur la forme exacte du contenu par type — reportée à la couche applicative. Risque identifié à grande échelle : nécessité éventuelle d'un partitionnement PostgreSQL (par `user_id` ou `type`) — évolution opérationnelle, pas une remise en cause du modèle.
