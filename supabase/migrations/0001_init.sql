-- Schéma initial V0.1 — Personal Intelligence OS
-- Reflète docs/architecture/system-architecture.md et docs/architecture/memory-system.md

create extension if not exists vector;

-- Conversations et messages : historique brut, distinct de la mémoire structurée.

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_id_idx on conversations (user_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_conversation_id_idx on messages (conversation_id);

-- Memory Engine : table unique, discriminée par type (ADR-0003).
-- Dimension de l'embedding à ajuster selon le fournisseur choisi (1536 = défaut provisoire).

create table memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('profil', 'projet', 'relationnel', 'episodique', 'temporaire', 'regles')),
  content text not null,
  structured_content jsonb not null default '{}'::jsonb,
  source_type text not null check (source_type in ('explicite', 'infere', 'resultat_outil', 'importe')),
  source_turn_id uuid,
  event_date timestamptz,
  last_confirmed_at timestamptz,
  confidence numeric not null default 1.0 check (confidence >= 0 and confidence <= 1),
  importance numeric not null default 0.5 check (importance >= 0 and importance <= 1),
  sensitivity text not null default 'normal' check (sensitivity in ('public', 'normal', 'sensible')),
  retention_policy text not null default 'permanent' check (retention_policy in ('permanent', 'expire', 'session_only')),
  status text not null default 'proposed' check (status in ('proposed', 'active', 'superseded', 'expired', 'deleted')),
  supersedes_id uuid references memory_items (id),
  project_id uuid references memory_items (id),
  related_person_ids uuid[] not null default '{}',
  embedding vector(1536),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index memory_items_user_id_idx on memory_items (user_id);
create index memory_items_type_idx on memory_items (type);
create index memory_items_status_idx on memory_items (status);
create index memory_items_project_id_idx on memory_items (project_id);

-- Context Engine : un seul état actif par utilisateur (ADR-0004).

create table context_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active_project_id uuid references memory_items (id),
  active_task text,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  recent_entities jsonb not null default '[]'::jsonb,
  pending_confirmations jsonb not null default '[]'::jsonb,
  last_device text,
  last_modality text,
  updated_at timestamptz not null default now()
);

-- Audit Journal : append-only, jamais modifié après écriture.

create table audit_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  turn_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_journal_user_id_idx on audit_journal (user_id);
create index audit_journal_turn_id_idx on audit_journal (turn_id);

-- Isolation stricte par utilisateur (RLS) — menace n°3 du threat model.

alter table conversations enable row level security;
alter table messages enable row level security;
alter table memory_items enable row level security;
alter table context_state enable row level security;
alter table audit_journal enable row level security;

create policy "own conversations" on conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own messages" on messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own memory items" on memory_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own context state" on context_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own audit journal" on audit_journal
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
