# Architecture système — référence officielle (figée)

Ce document est la référence officielle du projet. Toute évolution devra être justifiée par un besoin concret rencontré pendant le développement, jamais par anticipation.

## Composants (7, aucun de plus)

| Composant | Responsabilité unique |
|---|---|
| Orchestrateur | Piloter le cycle de vie d'un tour de conversation. Seul point de décision "que fait-on maintenant". Ne contient aucune logique métier propre à un autre composant. |
| Context Engine | Maintenir et résoudre le focus actif de l'utilisateur (projet, tâche, entités récentes, confiance). État mutable, écrasé en place — distinct de l'historique de faits. |
| Memory Engine | Décider ce qui devient un fait persisté (moteur de décision), le stocker avec son cycle de vie (provenance, confiance, expiration, supersession), le restituer contextuellement. |
| AI Provider | Adaptateur pur vers le(s) fournisseur(s) de modèle. Aucune logique métier. Permet un changement de fournisseur/modèle sans toucher le reste du système. |
| Permission Gate | Frontière de sécurité : étant donné une action + sa classification de risque + la politique utilisateur, autorise / demande confirmation / refuse. Indépendante du raisonnement du modèle. |
| Tool Executor | Exécute un outil précis déjà autorisé par la Gate. Valide les paramètres, retourne un résultat structuré ou une erreur. Ne s'auto-autorise jamais. |
| Audit Journal | Enregistrement append-only de toute décision, action, tentative ou échec. Passif — n'interprète ni ne filtre ce qu'il enregistre. |

**Explicitement exclus du périmètre V1** : Knowledge Engine et Plan. Ce sont des points d'extension documentés (voir section « Extensions futures »), pas des composants construits. Ils ne réapparaissent que si un cas d'usage réel les justifie (documents/vision pour Knowledge, outils multi-étapes réels pour Plan — au plus tôt V0.3+).

## Contrats

Voir le tableau des contrats conceptuels dans l'historique de conception (reçoit / renvoie / droits / interdits / dépendances) — repris ici pour référence :

- **Orchestrateur** — reçoit : message + métadonnées device/modalité. Renvoie : réponse finale + statut du tour. Droit : consulter tout composant, appeler l'AI Provider plusieurs fois par tour, arbitrer la boucle d'outils. Interdit : contenir la logique d'un autre composant, exécuter une action sans passer par la Gate.
- **Context Engine** — reçoit : requête de lecture/écriture de focus. Renvoie : focus actif. Droit : écraser son propre état. Interdit : décider d'une action, écrire en mémoire long terme.
- **Memory Engine** — reçoit : candidat de mémorisation ou requête de récupération. Renvoie : souvenirs pertinents ou confirmation d'écriture/rejet. Droit : classer, proposer, superséder. Interdit : auto-stocker sans passer par le moteur de décision, exposer un souvenir hors permission.
- **AI Provider** — reçoit : prompt assemblé + schéma d'outils + config. Renvoie : texte ou demande d'appel d'outil. Interdit : décider d'exécuter une action, contourner la Gate.
- **Permission Gate** — reçoit : action + risque + politique utilisateur. Renvoie : autorisation/confirmation requise/refus. Interdit : exécuter une action elle-même, se fier au raisonnement du modèle comme justification suffisante.
- **Tool Executor** — reçoit : outil + paramètres validés + autorisation. Renvoie : résultat structuré ou erreur. Interdit : s'auto-autoriser.
- **Audit Journal** — reçoit : événement. Renvoie : confirmation d'écriture / historique. Interdit : modifier une entrée existante.

## Schéma

```
                          Utilisateur
                               │
                               ▼
                    ┌───────────────────────┐
                    │      ORCHESTRATEUR     │
                    └───────────┬─────────────┘
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
       Context Engine    Memory Engine      AI Provider
              │                │                 │
              └────────────────┴────────┬────────┘
                                         ▼
                              demande d'appel d'outil ?
                              ┌──────────┴──────────┐
                              ▼                     ▼
                       Permission Gate        réponse texte directe
                              │
                    autorisé  │  confirmation requise
              ┌───────────────┴───────────────┐
              ▼                               ▼
        Tool Executor                 action en attente
                                       (Context Engine)
              │                               │
              └───────────────┬───────────────┘
                               ▼
                        Audit Journal
```

## Flux principaux

- **Conversation simple** : message → Orchestrateur → contexte + mémoire pertinents → AI Provider → réponse → mise à jour du contexte → journal.
- **Outil sans risque** : AI Provider demande un outil → Gate autorise → Tool Executor exécute → résultat réinjecté → réponse finale → journal.
- **Confirmation (action sensible/externe)** : Gate exige confirmation → tour suspendu, action en attente stockée dans le Context Engine → confirmation lors d'un tour ultérieur → exécution → journal.
- **Mémoire** : candidat détecté → extraction structurée (AI Provider, modèle économique) → moteur de décision mémoire → proposition à l'utilisateur (aucun auto-stockage en V0.1) → écriture avec provenance, gestion de la supersession → journal.
- **Erreur** : capturée explicitement à toute étape, jamais présentée comme un succès simulé, journalisée avec sa cause.

## Extensions futures (hors périmètre V1, non construites)

- **Knowledge Engine** : ingestion de documents/connaissances générales (distinct de la mémoire personnelle). Déclenché par un cas d'usage réel (fichiers V0.3, vision V0.4).
- **Plan** : modèle de données pour objectifs multi-étapes, rattaché à la mémoire projet. Déclenché par l'existence d'outils réels multi-étapes (V0.3+).
- **Reprise événementielle de l'Orchestrateur** : aujourd'hui strictement synchrone (déclenché uniquement par un message utilisateur). Une reprise déclenchée par un événement externe est un changement de contrat volontairement différé.
- **Résolution multi-device du Context Engine** : aujourd'hui un focus par utilisateur. Une clé par device/thread sera nécessaire dès qu'un deuxième client concurrent existe (V0.6+).

Voir `docs/decisions/` pour les ADR détaillant chaque choix, `docs/architecture/memory-system.md` pour le détail du Memory Engine, et `docs/architecture/tool-system.md` pour le détail de Permission Gate / Tool Executor (implémentés en V1.1).
