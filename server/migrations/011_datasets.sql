-- 0.4.0: Datensätze als eigenständige, versionierte Objekte (Fälle, Dokumente, Bilder) mit Hash, Sprache und Sensitivität.

create table datasets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants (id) on delete cascade,          -- leer = global (offiziell, mitgeliefert)
  key          text not null,
  name         text not null,
  description  text,
  kind         text not null check (kind in ('qa', 'prompts', 'attacks', 'coding', 'tools', 'documents')),
  language     text not null default 'de',
  sensitivity  text not null default 'internal' check (sensitivity in ('public', 'internal', 'customer', 'attack')),
  origin       text not null default 'tenant' check (origin in ('official', 'tenant')),
  min_cases    int not null default 30,                                  -- ab dieser Zahl gilt eine Stichprobe als aussagekräftig
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index datasets_key_idx on datasets (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- Versionen sind unveränderlich; Änderungen erzeugen eine neue Version.
create table dataset_versions (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references datasets (id) on delete cascade,
  version     text not null,
  hash        text not null,
  case_count  int not null default 0,
  file_count  int not null default 0,
  notes       text,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (dataset_id, version)
);

create table dataset_cases (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references dataset_versions (id) on delete cascade,
  position    int not null,
  case_key    text,
  difficulty  int not null check (difficulty between 1 and 5),
  category    text not null,
  data        jsonb not null
);
create index dataset_cases_version_idx on dataset_cases (version_id, position);

create table dataset_files (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references dataset_versions (id) on delete cascade,
  name         text not null,
  content_type text not null,
  size         int not null,
  hash         text not null,
  content      bytea not null,
  unique (version_id, name)
);
