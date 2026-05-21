create table if not exists users (
  id uuid primary key,
  username text not null,
  email text not null,
  email_normalized text not null unique,
  password_hash text not null,
  password_salt text not null,
  password_iterations integer not null default 210000,
  role text not null default 'user',
  created_ip text not null default '',
  created_user_agent text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists users_username_lower_idx on users (lower(username));
create index if not exists users_created_at_idx on users (created_at desc);

alter table users
  add column if not exists role text not null default 'user';

create table if not exists user_sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  device_label text not null default '',
  ip text not null default '',
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists user_sessions_user_id_idx on user_sessions (user_id, created_at desc);
create index if not exists user_sessions_token_hash_idx on user_sessions (token_hash);

create table if not exists user_events (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  event_type text not null,
  entity_type text not null default '',
  entity_id text not null default '',
  ip text not null default '',
  user_agent text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_events_user_id_idx on user_events (user_id, created_at desc);
create index if not exists user_events_created_at_idx on user_events (created_at desc);

create table if not exists request_telemetry (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  session_id uuid,
  method text not null,
  path text not null,
  ip text not null default '',
  user_agent text not null default '',
  device_label text not null default '',
  browser text not null default '',
  os text not null default '',
  device_type text not null default '',
  referer text not null default '',
  accept_language text not null default '',
  cf_country text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists request_telemetry_created_at_idx
  on request_telemetry (created_at desc);

create index if not exists request_telemetry_ip_idx
  on request_telemetry (ip, created_at desc);

create index if not exists request_telemetry_user_id_idx
  on request_telemetry (user_id, created_at desc);

create table if not exists admin_blocks (
  id uuid primary key,
  block_type text not null check (block_type in ('ip', 'user')),
  value text not null,
  reason text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create unique index if not exists admin_blocks_active_idx
  on admin_blocks (block_type, lower(value))
  where revoked_at is null;

create table if not exists file_metadata_analyses (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  original_name text not null,
  extension text,
  mime_type text,
  file_size_bytes bigint not null check (file_size_bytes >= 0 and file_size_bytes <= 1073741824),
  metadata jsonb not null,
  created_at timestamptz not null default now()
);

alter table file_metadata_analyses
  add column if not exists user_id uuid references users(id) on delete set null;

create index if not exists file_metadata_analyses_created_at_idx
  on file_metadata_analyses (created_at desc);

create index if not exists file_metadata_analyses_mime_type_idx
  on file_metadata_analyses (mime_type);

create index if not exists file_metadata_analyses_user_id_idx
  on file_metadata_analyses (user_id, created_at desc);
