# ADR-0012 — Confirmations d'outil : dédoublonnage intra-tour et expiration stricte inter-tour

## Statut
Accepté. Limite résiduelle assumée et documentée (voir dernière section).

## Contexte
Deux bugs réels ont été trouvés par des tests en conditions réelles (navigateur réel + vrai Claude), pas par un raisonnement théorique.

**Bug 1 — double appel dans un même tour.** Le modèle appelait parfois deux fois le même outil dans la même réponse après un premier résultat "confirmation requise", empilant deux confirmations en attente distinctes pour le même outil.

**Bug 2 — confirmation périmée résolue par un message sans rapport.** Le modèle répond parfois en texte libre à sa propre demande d'autorisation sans réellement appeler l'outil, donc sans qu'aucune confirmation ne soit enregistrée côté infrastructure. Quand l'utilisateur répond ensuite, le tour redémarre normalement et une vraie confirmation est créée cette fois. Si un message ultérieur et totalement sans rapport arrivait après, le classifieur de résolution (un appel LLM isolé, sans le contexte complet de la conversation) pouvait le classer à tort comme une réponse à cette confirmation, exécutant une ancienne demande à la place de la nouvelle.

## Décision

**Dédoublonnage intra-tour (bug 1).** Un `Set` en mémoire, local à l'exécution du tour, retient les noms d'outils ayant déjà produit une demande de confirmation dans ce même tour. Toute tentative supplémentaire du modèle d'appeler le même outil dans la même réponse est bloquée de façon déterministe (dans le code, pas seulement par une consigne au modèle) avant même d'atteindre le Permission Gate.

**Expiration stricte inter-tour (bug 2 — option A retenue parmi trois proposées).** Une confirmation d'outil en attente n'est valable que pour le tour utilisateur qui suit immédiatement sa création. Si ce tour ne la résout pas explicitement (once/session/always/deny), elle expire avant tout traitement du message courant — jamais conservée pour un tour ultérieur. Préférence explicite : perdre une confirmation et devoir la redemander plutôt que risquer d'exécuter une ancienne demande sur un nouveau message.

Écartées : un verrou applicatif complexe, et le remplacement immédiat du classifieur par une résolution pilotée par le modèle principal (option B) — jugée nécessaire à moyen terme mais pas requise pour prouver l'infrastructure de la V1.1.

## Preuve

11 tests d'intégration réels (`src/core/orchestrator/tool-flow.integration.test.ts`), dont une reproduction déterministe exacte de chaque bug et 6 scénarios explicitement couverts : réponse immédiate, réponse négative, aparté utilisateur avant réponse, nouveau sujet, confirmation expirée, absence totale de réponse.

## Limite résiduelle démontrée (pas seulement théorique)

Un smoke test réel (vrai navigateur, vrai Claude) après l'implémentation de l'expiration stricte a montré que le classifieur peut, occasionnellement, encore mal classer un message de "nouveau sujet" comme une résolution positive plutôt que "sans rapport" — auquel cas l'expiration stricte n'a pas le temps de s'appliquer (la confirmation est résolue, à tort, dès ce même tour immédiatement suivant). L'option A réduit la fenêtre d'exposition (un seul tour au lieu de tous les tours futurs) mais ne l'élimine pas totalement : c'est exactement le risque que l'option B (résolution par le modèle principal, disposant du contexte complet de la conversation, plutôt qu'un classifieur isolé) est censée éliminer.

## Conséquences

`tool_permission_deferred` est retiré du vocabulaire d'audit, remplacé par `tool_permission_expired` (sémantique différente : une confirmation non résolue au tour suivant n'est plus jamais "en attente", elle est immédiatement expirée). Prochaine étape recommandée, à prioriser en V1.2 : remplacer le classifieur isolé (`resolveToolPermissionResponse`) par une résolution portée par le modèle de raisonnement principal, qui dispose de tout l'historique de conversation — sans que cela retarde la clôture de la V1.1.
