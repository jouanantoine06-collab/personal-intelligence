-- Ajoute la traçabilité du tour d'origine sur les messages.
-- Nécessaire pour la tranche "contrôle utilisateur de la mémoire" : afficher, pour
-- un souvenir donné, le message exact qui l'a déclenché (memory_items.source_turn_id
-- ne suffisait pas seul à retrouver le contenu du message). Ajout additif, ne modifie
-- aucun composant de l'architecture figée (la table messages n'est pas un des 7
-- composants du cerveau, c'est la plomberie de stockage de conversation).

alter table messages add column turn_id uuid;

create index messages_turn_id_idx on messages (turn_id);
