# Système d'outils (V1.1 / V1.2) — référence détaillée

Implémentation concrète de deux des 7 composants figés (Permission Gate, Tool Executor — `docs/architecture/system-architecture.md`), jusque-là non exercés faute d'outil réel, plus le Tool Registry (structure de support, ADR-0011).

## Niveaux de risque

`no_risk` (lecture, jamais de confirmation) · `reversible` (écriture facilement annulable, confirmation obligatoire) · `external` (effet visible hors du système) · `sensitive` (fort enjeu). Déclarés par chaque outil dans le Tool Registry, jamais devinés par le modèle.

## Tool Registry

`src/core/tool-registry/index.ts`. Une `Map<string, ToolDefinition>` en mémoire. Chaque outil déclare : nom, description, `riskLevel`, `requiredPermission`, schéma JSON exposé au modèle (`aiInputSchema`), validation stricte côté serveur (`parseInput`, jamais confiance dans l'entrée du modèle), fonction d'exécution. `registerTool` est idempotent.

Premier outil (`src/core/tool-registry/builtin-tools.ts`) : notes internes, volontairement trivial — `list_internal_notes` (`no_risk`) et `create_internal_note` (`reversible`, délibérément gaté pour prouver le cycle de confirmation).

## Permission Gate

`src/core/permission-gate/index.ts`. `checkPermission` : `no_risk` → toujours autorisé ; sinon, cherche une autorisation déjà accordée (`tool_permissions`, scope `session` pour la conversation courante ou `always`) → autorisé si trouvée, sinon confirmation requise. `grantPermission` enregistre une autorisation `session` ou `always` — jamais `once`, qui n'autorise que l'action en attente au moment de la confirmation sans persister de ligne.

## Tool Executor

`src/core/tool-executor/index.ts`. `executeTool` exige une autorisation `{status:"allowed"}` explicite en paramètre (levée d'erreur sinon — ne s'auto-autorise jamais), retrouve l'outil via le Registry, valide l'entrée, exécute, journalise systématiquement (succès et échec).

## Cycle de confirmation

Une confirmation d'outil vit dans `context_state.pending_confirmations` (kind `tool_execution`), avec un identifiant stable (`id`) et son `conversationId` d'origine.

### Garde-fous découverts et corrigés en conditions réelles (ADR-0012, ADR-0013)
- **Dédoublonnage intra-tour** : un même outil ne peut générer qu'une seule demande de confirmation par tour, même si le modèle tente de le rappeler.
- **Résolution pilotée par le modèle principal (V1.2, ADR-0013)** : la résolution n'est plus un classifieur isolé pré-tour (supprimé), mais un outil structuré (`resolve_pending_confirmation`) proposé au modèle de raisonnement principal — avec tout l'historique de conversation — uniquement quand une confirmation est éligible pour la conversation courante. Décision en 4 valeurs : `confirm` (+ `scope` obligatoire, jamais deviné), `reject`, `unrelated`, `clarify`. Schéma strict (`additionalProperties: false`) : le modèle ne peut jamais transporter de contenu de remplacement pour l'action — l'exécution utilise toujours le `rawInput` figé à la demande initiale.
- **Expiration stricte, désormais exhaustive** : toute confirmation non résolue explicitement (`confirm`/`reject`) — sortie invalide, `unrelated`, `clarify`, absence d'appel, ou erreur/timeout du modèle pendant ce tour — expire immédiatement, y compris dans le chemin d'échec du tour. Journalisée avec un `reason` précis.

## Ce qui n'est pas construit (hors périmètre V1.1/V1.2)

Aucun connecteur externe (Gmail, GitHub, calendrier). Aucune permission à granularité plus fine que le nom de l'outil (`requiredPermission` existe comme point d'extension, non exploité). Aucun mécanisme de "toujours refuser" persistant — un refus n'est valable que pour l'instance en cours.
