-- V1.3a — connexion Google Calendar (OAuth). Une ligne par utilisateur.
--
-- Décision de sécurité (voir ADR-0014) : contrairement à toutes les tables
-- précédentes de ce projet, celle-ci n'accorde AUCUNE policy RLS aux rôles
-- `authenticated` ou `anon`. RLS activée sans policy = accès refusé par défaut
-- à quiconque n'utilise pas la clé service-role. Le navigateur de
-- l'utilisateur ne peut donc jamais lire ni écrire cette table, même la
-- sienne — seul du code serveur dédié (clé service-role) y accède, et ce
-- code doit alors filtrer explicitement par user_id lui-même puisque
-- Postgres ne le fait plus pour lui ici.
--
-- Les tokens sont de toute façon chiffrés avant stockage (AES-256-GCM, voir
-- src/lib/crypto/token-cipher.ts) : même une fuite de la base ne suffit pas
-- à les récupérer sans OAUTH_TOKEN_ENCRYPTION_KEY, qui n'existe que côté serveur.
create table google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  token_expires_at timestamptz not null,
  granted_scopes text not null,
  status text not null default 'active' check (status in ('active', 'error')),
  last_error text,
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  constraint google_calendar_connections_user_id_key unique (user_id)
);

create index google_calendar_connections_user_id_idx on google_calendar_connections (user_id);

alter table google_calendar_connections enable row level security;
-- Intentionnellement : aucune policy `for select/insert/update/delete` ici.
