# ADR-0006 — Pas de Planning Engine comme composant pair ; Plan différé

## Statut
Accepté (figé).

## Contexte
Besoin identifié : décomposer un objectif complexe (ex. "organise mon voyage à Maurice") en étapes suivies dans le temps, reprenables entre sessions/devices.

## Décision
Rejet d'un Planning Engine autonome, pair de l'Orchestrateur (risque d'ambiguïté d'autorité : deux composants capables de décider "quoi faire ensuite"). À la place : un modèle de données `plan` (steps, statut, dépendances), rattaché à la mémoire projet, consulté par l'Orchestrateur comme une capacité et non comme un second point de décision. Toute étape de plan qui déclenche une action externe/sensible repasse par la même Permission Gate qu'une action ordinaire.

## Conséquences
Aucun comportement de planification construit en V0.1 (pas assez d'outils réels pour qu'un plan ait quoi que ce soit à orchestrer). Introduit au plus tôt en V0.3, quand email/calendrier/tâches existent.
