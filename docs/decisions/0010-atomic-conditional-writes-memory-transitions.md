# ADR-0010 — Transitions du Memory Engine par écriture conditionnelle atomique

## Statut
Accepté.

## Contexte
La tranche de validation en conditions réelles (provisionnement Supabase, tests d'intégration RLS, parcours navigateur réel) incluait un test de concurrence ciblé sur `confirmMemory`, conformément au principe "commence par écrire un test qui reproduit le risque" avant toute correction structurelle.

Le test a été exécuté 5 fois : dans 2 cas sur 5, deux appels concurrents à `confirmMemory` sur le même souvenir proposé réussissaient tous les deux silencieusement, sans qu'aucun des deux ne reçoive d'erreur de conflit. Cause : `confirmMemory` (et, par le même schéma, `rejectMemory`, `editProposedMemory`, `correctActiveMemory`, `deleteActiveMemory`) lisait le statut courant, le vérifiait en code applicatif, puis écrivait séparément — une fenêtre de temps (TOCTOU) pendant laquelle deux requêtes concurrentes pouvaient toutes deux lire le même statut valide avant qu'aucune n'ait écrit.

Aucune ligne dupliquée n'était créée (les deux écritures ciblaient la même ligne), mais la garantie "l'autre reçoit une erreur de conflit honnête" n'était pas respectée.

## Décision
Chaque transition d'état est désormais réalisée par une **écriture conditionnelle atomique** : `UPDATE memory_items SET ... WHERE id = X AND user_id = Y AND status = <statut_attendu>`. Une seule instruction SQL décide seule si la transition a lieu — jamais une lecture préalable suivie d'une décision applicative puis d'une écriture séparée. Si aucune ligne n'est modifiée, une lecture de diagnostic qualifie l'erreur (souvenir introuvable vs conflit de statut) mais n'influence jamais la décision déjà prise par l'écriture elle-même.

Implémenté via un helper partagé `performGatedUpdate` (`src/core/memory-engine/index.ts`), utilisé symétriquement par `confirmMemory`, `rejectMemory`, `editProposedMemory`, `correctActiveMemory` et `deleteActiveMemory`. Pour `correctActiveMemory`, la supersession atomique de l'ancien souvenir a lieu *avant* l'insertion de la nouvelle version, afin qu'un conflit détecté n'aboutisse jamais à une ligne "active" orpheline.

Explicitement écarté : verrou applicatif (`SELECT ... FOR UPDATE`) ou mécanisme de verrouillage distribué — l'écriture conditionnelle suffit et reste triviale à auditer.

## Preuve
Un test de concurrence dédié (`src/core/memory-engine/concurrency.integration.test.ts`, gated par les mêmes variables d'environnement que les tests RLS) répète 15 fois chacun des scénarios confirm-vs-confirm, confirm-vs-reject et delete-vs-delete contre un vrai Postgres. Voir le rapport de la tranche de validation pour les résultats d'exécution.

## Conséquences
Les 5 fonctions de transition suivent désormais un schéma identique et symétrique, plus simple à auditer qu'avant (une seule clause WHERE exprime toute la règle de transition valide, remplaçant la table de correspondance action→statuts de l'ancien `assertValidTransition`, retiré car devenu redondant). Limite connue et assumée : la supersession "best-effort" de l'ancien souvenir dans `confirmMemory`, et l'enchaînement supersession-puis-insertion dans `correctActiveMemory`, restent deux opérations séparées (pas une transaction Postgres unique) — un échec entre les deux resterait possible dans un cas limite (ex. panne réseau entre les deux appels). Une vraie garantie transactionnelle nécessiterait une fonction Postgres (RPC) dédiée, jugée hors de proportion avec le risque actuel.
