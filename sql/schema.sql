create table if not exists file_metadata_analyses (
  id bigserial primary key,
  original_name text not null,
  extension text,
  mime_type text,
  file_size_bytes bigint not null check (file_size_bytes >= 0 and file_size_bytes <= 1073741824),
  metadata jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists file_metadata_analyses_created_at_idx
  on file_metadata_analyses (created_at desc);

create index if not exists file_metadata_analyses_mime_type_idx
  on file_metadata_analyses (mime_type);
