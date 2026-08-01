# ADR-0014 — Stockage sécurisé des tokens OAuth Google Calendar

## Statut
Accepté.

## Contexte
V1.3a introduit le premier connecteur externe (Google Calendar), donc le
premier secret réellement sensible stocké par ce projet : un `refresh_token`
OAuth équivaut à un accès durable au calendrier Google d'un utilisateur.
Jusqu'ici, l'isolation entre utilisateurs reposait entièrement sur RLS
(`auth.uid() = user_id`) avec le client Supabase scopé à la session — jamais
la clé service-role en dehors des scripts de test. Ce pattern protège contre
l'accès d'un utilisateur aux données d'un autre, mais pas contre la lecture
par le navigateur de l'utilisateur de **ses propres** secrets (XSS, extension
compromise) — un risque nouveau et disproportionné dès qu'il s'agit d'un
token OAuth plutôt que d'une note interne.

## Décision

**RLS deny-all + client privilégié séparé.** La table
`google_calendar_connections` (migration 0004) a RLS activée mais **aucune
policy** pour `authenticated` ni `anon` — Postgres refuse donc tout accès
depuis le client de session, y compris à l'utilisateur pour sa propre ligne.
Seul `src/lib/supabase/service-role.ts` (clé service-role, contourne RLS) y
accède, depuis du code strictement serveur (routes OAuth, exécution future
des outils calendrier). Conséquence assumée : RLS ne filtrant plus rien ici,
chaque requête du code applicatif doit filtrer explicitement sur `user_id` —
vérifié par `src/core/google-calendar/connections-rls.integration.test.ts`
contre un vrai Postgres (deux utilisateurs réels, isolation croisée prouvée).

**Chiffrement applicatif en plus de RLS, pas à la place.** `access_token` et
`refresh_token` sont chiffrés (AES-256-GCM, `src/lib/crypto/token-cipher.ts`)
avant stockage, avec une clé dédiée (`OAUTH_TOKEN_ENCRYPTION_KEY`, 32 octets
base64, distincte des clés Supabase/Google) :
- IV aléatoire de 12 octets à chaque chiffrement, jamais réutilisé ;
- tag d'authentification GCM stocké et vérifié — toute altération du texte
  chiffré ou du tag fait échouer le déchiffrement explicitement ;
- `user_id` lié en AAD (donnée authentifiée non chiffrée) : déchiffrer avec
  un `user_id` différent de celui utilisé au chiffrement échoue toujours,
  même si la ligne elle-même était mal ciblée par un bug ;
- format stocké versionné (`v1:iv:tag:ciphertext`) pour permettre une
  évolution future sans ambiguïté.

Ni bibliothèque tierce ni schéma maison : uniquement `node:crypto`, un
algorithme standard, un mode d'emploi documenté (IV aléatoire par message,
AEAD, clé de taille fixe validée au chargement).

## Conséquences
Ce projet a maintenant deux régimes d'isolation différents et volontairement
distincts : RLS partout ailleurs (le pattern par défaut, à garder pour toute
donnée non-secrète), RLS deny-all + service-role uniquement pour un secret
d'une gravité nouvelle (tokens OAuth). Ne pas généraliser ce second pattern à
une table qui n'en a pas besoin — il déplace la responsabilité d'isolation de
Postgres vers le code applicatif, ce qui n'est justifié que quand le contenu
lui-même (pas seulement son accès inter-utilisateur) est sensible.
