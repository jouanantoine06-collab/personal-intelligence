# Système d'outils (V1.1) — référence détaillée

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

Une confirmation d'outil vit dans `context_state.pending_confirmations` (même mécanisme que les propositions mémoire, kind `tool_execution`). Résolue par un appel modèle dédié (`resolveToolPermissionResponse`) à cinq issues possibles : `once` (exécute sans persister), `session`/`always` (accorde puis exécute), `deny` (refuse, rien exécuté), `unrelated` (voir expiration ci-dessous).

### Garde-fous découverts et corrigés en conditions réelles (ADR-0012)
- **Dédoublonnage intra-tour** : un même outil ne peut générer qu'une seule demande de confirmation par tour, même si le modèle tente de le rappeler.
- **Expiration stricte inter-tour** : une confirmation n'est valable que pour le tour immédiatement suivant sa création ; si ce tour ne la résout pas explicitement, elle expire avant tout traitement du nouveau message. Limite résiduelle documentée dans l'ADR : le classifieur de résolution peut encore, rarement, mal classer un nouveau sujet — l'expiration stricte réduit la fenêtre d'exposition, ne l'élimine pas. Amélioration prévue (V1.2, non bloquante) : résolution portée par le modèle principal plutôt qu'un classifieur isolé.

## Ce qui n'est pas construit (hors périmètre V1.1)

Aucun connecteur externe (Gmail, GitHub, calendrier). Aucune permission à granularité plus fine que le nom de l'outil (`requiredPermission` existe comme point d'extension, non exploité). Aucun mécanisme de "toujours refuser" persistant — un refus n'est valable que pour l'instance en cours.
