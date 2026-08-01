-- V1.1 — infrastructure générale d'utilisation d'outils (Permission Gate, Tool
-- Registry, Tool Executor). Aucune modification des 7 composants figés : ces deux
-- tables sont la plomberie de persistance dont Permission Gate et Tool Executor
-- ont besoin, au même titre que `messages`/`conversations` pour l'Orchestrateur.

-- Autorisations d'outils accordées par l'utilisateur ("pour cette session" ou
-- "toujours"). "une fois" ne persiste jamais de ligne ici — elle n'autorise que
-- l'action en attente au moment de la confirmation.
create table tool_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tool_name text not null,
  scope text not null check (scope in ('session', 'always')),
  conversation_id uuid references conversations (id) on delete cascade,
  granted_at timestamptz not null default now(),
  constraint tool_permissions_scope_conversation_chk check (
    (scope = 'session' and conversation_id is not null) or
    (scope = 'always' and conversation_id is null)
  )
);

create index tool_permissions_lookup_idx on tool_permissions (user_id, tool_name);

alter table tool_permissions enable row level security;

create policy "own tool permissions" on tool_permissions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Premier outil de démonstration : notes internes. Un outil en lecture (aucun
-- risque) et un outil en écriture (risque réversible, nécessite confirmation) —
-- de quoi prouver les deux branches du Permission Gate.
create table internal_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index internal_notes_user_id_idx on internal_notes (user_id);

alter table internal_notes enable row level security;

create policy "own internal notes" on internal_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
