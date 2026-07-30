# ADR-0008 — Aucun auto-stockage mémoire en V0.1

## Statut
Accepté (figé).

## Contexte
Le moteur de décision mémoire pourrait, en théorie, auto-stocker certaines catégories jugées "évidentes" sans confirmation utilisateur.

## Décision
Aucune catégorie n'est en auto-stockage en V0.1. Tout candidat de mémorisation (explicite ou inféré) passe par une confirmation explicite de l'utilisateur avant écriture.

## Conséquences
Expérience plus lente à l'usage (plus de confirmations) mais élimine un risque de confiance dès le premier jour. À revoir une fois la fiabilité de l'extraction mesurée sur un volume réel de mémoires confirmées (taux de correction/rejet observé).
