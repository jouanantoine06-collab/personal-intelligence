# ADR-0013 — Résolution des confirmations d'outil pilotée par le modèle principal

## Statut
Accepté.

## Contexte
ADR-0012 avait introduit l'expiration stricte (option A) pour limiter la fenêtre d'exposition d'une confirmation d'outil en attente, après qu'une race condition eut montré qu'un message ultérieur sans rapport pouvait, via un classifieur isolé (`resolveToolPermissionResponse`, un appel Haiku séparé ne voyant que le contenu en attente + le dernier message, sans le reste de la conversation), être mal classé comme une résolution et exécuter une ancienne demande à la place de la nouvelle.

Un smoke test réel après l'option A a confirmé la limite déjà anticipée : le classifieur isolé pouvait encore, occasionnellement, mal classer un nouveau sujet dans le seul tour où l'expiration stricte lui laissait une dernière chance de se tromper.

## Décision

**Ancien mécanisme supprimé** : `src/core/orchestrator/tool-permission-resolution.ts` (classifieur isolé, appel IA séparé avant le tour principal) et son test associé.

**Nouveau mécanisme** : la résolution est désormais un outil structuré (`resolve_pending_confirmation`) proposé au modèle de raisonnement principal — dans le même appel que les autres outils, avec tout l'historique de la conversation — plutôt qu'un classifieur isolé pré-tour. Décision en 4 valeurs : `confirm` (+ `scope` obligatoire parmi once/session/always — jamais deviné), `reject`, `unrelated`, `clarify`.

Le modèle garde son rôle habituel : il propose. Le code reste seul décisionnaire, via des garanties structurelles, pas de simples consignes :
- l'outil de résolution n'est même proposé au modèle que s'il existe au moins une confirmation éligible pour la conversation courante (sinon il est absent des outils disponibles ce tour) ;
- chaque confirmation porte un identifiant stable (`id`) et son `conversationId` d'origine — la résolution doit désigner explicitement quelle confirmation elle traite (jamais par position) et n'est éligible que dans la même conversation ;
- le schéma d'entrée est strict (`additionalProperties: false`) : tout champ additionnel (tentative de fournir un contenu de remplacement) invalide toute la sortie ;
- l'exécution utilise exclusivement le `rawInput` figé au moment de la demande initiale — jamais un contenu venant de l'appel de résolution ;
- toute sortie invalide, ambiguë (`clarify`), sans rapport (`unrelated`), absente (le modèle n'appelle pas l'outil), ou toute erreur/timeout du modèle pendant ce tour, fait expirer la confirmation immédiatement (règle strict héritée d'ADR-0012, désormais appliquée uniformément y compris sur erreur, via un nettoyage systématique même dans le chemin d'échec du tour) ;
- toute décision est journalisée (`tool_permission_checked/requested/granted/denied/expired`, ce dernier avec un `reason` précis : `unrelated_message`, `ambiguous_clarify_requested`, `invalid_resolution_output`, `not_addressed_this_turn`, `turn_error`).

## Preuve
20 tests d'intégration réels (`src/core/orchestrator/tool-flow.integration.test.ts`) couvrant la chaîne complète et les 15 cas demandés (réponse immédiate, "une fois", "toujours", refus, annulation, ambiguïté, nouveau sujet, aparté puis réponse tardive, tentative de modification du payload pendant la confirmation, injection de prompt, confirmation expirée, absence de confirmation en attente, deux confirmations simultanées, réponse courte simulée, erreur/timeout du modèle).

Un smoke test réel (navigateur réel + vrai Claude) reproduisant exactement le scénario qui avait échoué sous l'option A (nouveau sujet après confirmation en attente) montre, sur deux exécutions consécutives, le modèle appeler correctement `resolve_pending_confirmation` avec `decision:"unrelated"` plutôt que d'exécuter l'ancienne demande — **aucune fausse confirmation observée**.

## Conséquences
La distinction Mémoire (classifieur isolé conservé, hors périmètre de cette tranche) / Outils (résolution pilotée par le modèle principal) est désormais assumée et documentée : deux mécanismes différents pour deux besoins de fiabilité différents, pas une incohérence. Risque résiduel : ce mécanisme dépend toujours du bon vouloir du modèle à appeler l'outil de résolution plutôt que de répondre en prose libre ou de rappeler directement l'outil cible — un comportement de modèle observé en conditions réelles (non spécifique à cette tranche) qui dégrade l'expérience (redemande une autorisation déjà accordée verbalement) sans jamais compromettre la sécurité (aucune exécution incorrecte n'en résulte, seulement une confirmation supplémentaire).
