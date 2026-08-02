# ADR-0015 — Relèvement de MAX_TOOL_ITERATIONS (4 → 8)

## Statut
Accepté.

## Contexte
`MAX_TOOL_ITERATIONS` (Orchestrateur) plafonne le nombre d'allers-retours
modèle↔outils dans un même tour, pour garantir qu'un tour se termine
toujours. Fixé à 4 en V1.1, quand un seul outil réel existait
(`create_internal_note`).

Pendant la validation réelle de V1.3d (modification/suppression
d'événements), une suppression légitime a échoué : le modèle a enchaîné
`list_calendar_events` (localiser l'événement), `delete_calendar_event`
(déclencher la demande d'autorisation), puis une itération supplémentaire
avant de produire une réponse — atteignant la limite de 4 sans qu'aucune
action incorrecte n'ait eu lieu (le tour s'est arrêté proprement, message
honnête, rien exécuté — vérifié dans l'Audit Journal). Avec 5 outils
calendrier pouvant légitimement s'enchaîner dans un seul échange (chercher,
puis agir), 4 itérations ne laissaient plus de marge pour un usage normal,
pas seulement pour une dérive du modèle.

## Décision
`MAX_TOOL_ITERATIONS` passe de 4 à 8. Aucun autre changement : même boucle,
même gestion d'erreur, même comportement en cas de dépassement (message
honnête, rien exécuté, `turn_failed` journalisé avec
`reason: "max_tool_iterations"`).

## Conséquences
Un vrai échange multi-outils (recherche puis action, avec éventuellement une
vérification de chevauchement) dispose maintenant d'assez de marge. Le
plafond reste néanmoins fini et déterministe : un tour ne peut toujours pas
boucler indéfiniment, il échoue proprement au-delà de 8 itérations avec le
même message honnête qu'avant.
