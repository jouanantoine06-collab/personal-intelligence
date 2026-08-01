# Changelog

Historique des tranches livrées, de V0.1 à V1.2. Pour le détail des décisions
d'architecture, voir `docs/decisions/`. Pour la référence technique courante,
voir `docs/architecture/`.

## v1.2.0 — Résolution sécurisée des confirmations d'outil + corrections critiques

### Le cerveau (inchangé dans son architecture, éprouvé en conditions réelles)
Orchestrateur, Context Engine et Memory Engine restent les trois composants
figés qu'ils étaient depuis V0.1 (`docs/architecture/system-architecture.md`).
Cette tranche ne les modifie pas structurellement ; elle corrige un défaut de
lecture d'historique dans l'Orchestrateur (voir « Corrections critiques »
ci-dessous) et étend son cycle de décision pour couvrir la résolution des
confirmations d'outil.

### Résolution des confirmations pilotée par le modèle principal
Le classifieur isolé de résolution (`resolveToolPermissionResponse`, un appel
Haiku séparé ne voyant que le contenu en attente + le dernier message,
introduit en V1.1) est **supprimé**. Remplacé par un outil structuré
(`resolve_pending_confirmation`) proposé au modèle de raisonnement
principal — dans le même appel que les autres outils, avec tout l'historique
de conversation — uniquement quand une confirmation est réellement éligible.
Décision en 4 valeurs (`confirm`+scope obligatoire / `reject` / `unrelated` /
`clarify`), schéma strict, exécution toujours sur le `rawInput` figé à la
demande initiale, expiration exhaustive de toute sortie invalide/ambiguë/
absente/en erreur. Voir ADR-0013.

Preuve : 20 tests d'intégration réels (les 5 tests de chaîne + les 15 cas
explicitement requis : réponse immédiate, une fois/toujours/refus/annulation,
ambiguïté, nouveau sujet, aparté puis réponse tardive, tentative de
modification du payload, injection de prompt, confirmation expirée, absence
de confirmation, deux confirmations simultanées, réponse courte simulée,
erreur/timeout du modèle) + deux smoke tests réels (navigateur + vrai Claude)
confirmant qu'aucune ancienne demande n'est jamais exécutée sur un message
sans rapport.

### Corrections critiques découvertes pendant la validation utilisateur réelle
Une session de démonstration complète, conduite comme un utilisateur réel
(pas de scripts, uniquement l'interface), a mis au jour trois défauts réels
au-delà de ce que les tests automatisés couvraient :

- **Pagination de l'historique de conversation (critique)** — la requête de
  lecture de l'historique récent triait en ordre croissant avec une limite,
  ce qui retournait toujours les 20 *premiers* messages d'une conversation au
  lieu des 20 *derniers*. Passé ce seuil, le message de l'utilisateur n'était
  plus jamais transmis au modèle → 400 de l'API Anthropic
  (« the conversation must end with a user message ») → 500 applicatif.
  Corrigée en triant en ordre décroissant avant de limiter, puis en remettant
  la fenêtre obtenue dans l'ordre chronologique. Revérifiée en direct sur la
  conversation qui avait échoué.
- **Duplication de proposition mémoire** — dans le même tour qu'une
  confirmation mémoire, le modèle pouvait rappeler `flag_memory_candidate` et
  reproposer le fait qui venait d'être confirmé (la détection de conflit par
  clé structurée exacte ratait aussi certains cas d'extraction incohérente,
  par exemple un accent différent entre deux passages sur le même fait).
  Corrigée en retirant cet outil des outils disponibles pour le reste du tour
  dès qu'une proposition mémoire vient d'être confirmée ou refusée.
  Revérifiée en direct.
- **Réponses en prose sans appel d'outil réel** — risque déjà documenté en
  ADR-0013, mais observé ici de façon répétée plutôt qu'occasionnelle. Les
  instructions du prompt système ont été renforcées (obligation d'appeler
  l'outil réel plutôt que de décrire une demande d'autorisation en prose,
  interdiction explicite d'appeler l'outil cible directement quand une
  confirmation est en attente). Atténuation, pas garantie structurelle : la
  sécurité ne reposait déjà pas sur la conformité du modèle sur ce point — le
  garde-fou d'expiration a tenu à chaque occurrence observée.

Effet de bord corrigé au passage : la configuration ESLint ne excluait pas
`.next/`, ce qui faisait fuir des milliers d'erreurs/avertissements du build
compilé dans le lint dès que `.next` existait sur disque.

## v1.1.0 — Infrastructure d'outils

Permission Gate et Tool Executor implémentés pour de vrai (présents dans
l'architecture figée depuis le début, jamais exercés faute d'outil réel),
plus le Tool Registry comme structure de support (ADR-0011, explicitement
non ajouté aux composants figés).

- **Tool Registry** — `Map` en mémoire, chaque outil déclare son
  `riskLevel` (`no_risk`/`reversible`/`external`/`sensitive`), son schéma
  d'entrée exposé au modèle et sa validation stricte côté serveur.
  `registerTool` idempotent.
- **Permission Gate** — `checkPermission`/`grantPermission` : lecture
  toujours autorisée, action réversible ou plus risquée nécessite une
  autorisation déjà accordée (`session` ou `always`) ou une confirmation.
- **Tool Executor** — exige une autorisation explicite `{status:"allowed"}`
  en paramètre (ne s'auto-autorise jamais), journalise systématiquement
  succès et échec.
- **Infrastructure des notes internes** — premier outil de démonstration,
  volontairement trivial : `list_internal_notes` (`no_risk`, jamais de
  confirmation) et `create_internal_note` (`reversible`, délibérément gaté
  pour prouver le cycle de confirmation de bout en bout). Aucun connecteur
  externe (Gmail, GitHub, calendrier) dans cette tranche ni la suivante.
- **Bugs réels corrigés via tests en conditions réelles** (au-delà de ce
  qu'un test scripté aurait révélé) : un même outil pouvait être rappelé deux
  fois dans un même tour, empilant deux confirmations distinctes ; une
  confirmation non résolue immédiatement pouvait être résolue par erreur par
  un message ultérieur sans rapport, exécutant une ancienne demande à la
  place de la nouvelle. Corrigés par un dédoublonnage intra-tour déterministe
  et une expiration stricte inter-tour (ADR-0012).

## Tranche de validation en conditions réelles (avant V1.1)

Provisionnement sur un vrai projet Supabase, parcours auth/chat/mémoire
testés pour de vrai (navigateur headless réel + vraie API Claude), tests RLS
et de concurrence exécutés contre le vrai projet.

- **Validation RLS** — `memory-management.integration.test.ts` prouve
  l'isolation par utilisateur contre un vrai Postgres (jamais un projet de
  production).
- **Protections contre les races** — `concurrency.integration.test.ts` prouve
  qu'aucune transition d'état mémoire (confirmation/refus/suppression) ne
  peut réussir en double sous concurrence, via écriture conditionnelle
  atomique (`UPDATE ... WHERE status = <attendu>`, ADR-0010) plutôt qu'une
  lecture préalable suivie d'une écriture.
- **Bugs réels trouvés et corrigés** : middleware jamais exécuté (mauvais
  emplacement de fichier avec une structure `src/`) — toutes les pages
  étaient accessibles sans authentification ; redirection HTML des routes
  `/api/*` par le middleware au lieu d'un 401 JSON ; réponses JSON de
  Claude/Haiku parfois encapsulées en ```` ```json ```` cassant l'extraction
  de candidat mémoire et la classification de confirmation ; race condition
  réelle sur les transitions d'état mémoire (ci-dessus).

## Deuxième tranche verticale — contrôle utilisateur de la mémoire

Interface complète `/memory` : liste filtrable (type/projet/statut/recherche
plein texte), propositions en attente (accepter/modifier/refuser), détail par
souvenir (provenance, message d'origine, chaîne de supersession), correction
(nouvelle version + supersession), suppression (soft-delete).

## v0.1.0 — Premier cerveau

Le socle du « cerveau » : Orchestrateur, Context Engine, Memory Engine, AI
Provider et Audit Journal (`src/core/`), Permission Gate et Tool Executor
hors périmètre (aucun outil réel encore).

- Authentification email/mot de passe, création de conversation,
  envoi/réception de messages.
- **Memory Engine** — mémorisation explicite avec confirmation obligatoire
  (ADR-0008 : jamais de stockage automatique), récupération par filtrage
  structuré (ADR-0009), table unique `memory_items` append-only avec
  supersession (ADR-0003).
- **AI Provider** — abstraction derrière l'Anthropic SDK, deux paliers
  (raisonnement / rapide), jamais d'appel direct au SDK ailleurs (ADR-0007).
- **Audit Journal** — journalisation de toutes les décisions dès cette
  première tranche.
- Architecture figée à 7 composants après audit critique explicite :
  Knowledge Engine et Planning Engine délibérément écartés (ADR-0005,
  ADR-0006) comme extensions futures, pas comme composants du socle.
