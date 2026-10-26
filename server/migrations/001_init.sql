-- Grundschema der AI Testing Suite.
-- gen_random_uuid() ist seit PostgreSQL 13 eingebaut, keine Extension (und keine Superuser-Rechte) nötig.

create table users (
  id            uuid primary key default gen_random_uuid(),
  sub           text not null unique,            -- OIDC subject aus Keycloak
  username      text not null,
  email         text,
  display_name  text,
  roles         text[] not null default '{}',    -- admin | tester | viewer
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table sessions (
  sid        text primary key,
  sess       jsonb not null,
  expires_at timestamptz not null
);
create index sessions_expires_idx on sessions (expires_at);

-- Zu testende Systeme: LiteLLM-Gateway, vLLM-Server, MCP-Server.
create table endpoints (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  kind          text not null check (kind in ('litellm', 'vllm', 'openai', 'mcp')),
  base_url      text not null,
  api_key_enc   text,                             -- AES-256-GCM, Schlüssel aus APP_SECRET
  headers       jsonb not null default '{}',
  models        text[] not null default '{}',
  default_model text,
  enabled       boolean not null default true,
  notes         text,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Test-Personas: Keycloak-Testuser oder API-Keys, mit denen Tests ausgeführt werden.
-- Damit lassen sich userspezifische Freigaben (Modelle, MCP-Tools) prüfen.
create table personas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  auth_type   text not null check (auth_type in ('keycloak_password', 'api_key', 'none')),
  username    text,
  secret_enc  text,
  attributes  jsonb not null default '{}',        -- z. B. Gruppen, Team, erwartete Rechte
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table test_definitions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null,                      -- mcp | access | performance | load | quality | ...
  endpoint_id uuid references endpoints (id) on delete cascade,
  persona_id  uuid references personas (id) on delete set null,
  config      jsonb not null default '{}',
  tags        text[] not null default '{}',
  enabled     boolean not null default true,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index test_definitions_type_idx on test_definitions (type);

-- Gebündelte Testläufe.
create table suites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table suite_tests (
  suite_id uuid not null references suites (id) on delete cascade,
  test_id  uuid not null references test_definitions (id) on delete cascade,
  position int not null default 0,
  primary key (suite_id, test_id)
);

create table schedules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  target_kind text not null check (target_kind in ('test', 'suite', 'all')),
  test_id     uuid references test_definitions (id) on delete cascade,
  suite_id    uuid references suites (id) on delete cascade,
  cron        text not null,
  timezone    text not null default 'Europe/Berlin',
  enabled     boolean not null default true,
  owner_id    uuid references users (id) on delete set null,
  last_run_at timestamptz,
  created_at  timestamptz not null default now()
);

create table runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('single', 'selection', 'suite', 'all')),
  trigger     text not null check (trigger in ('manual', 'schedule', 'api')),
  label       text,
  suite_id    uuid references suites (id) on delete set null,
  schedule_id uuid references schedules (id) on delete set null,
  user_id     uuid references users (id) on delete set null,
  test_ids    uuid[] not null default '{}',
  status      text not null default 'queued'
              check (status in ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')),
  total       int not null default 0,
  passed      int not null default 0,
  failed      int not null default 0,
  errored     int not null default 0,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index runs_user_created_idx on runs (user_id, created_at desc);
create index runs_created_idx on runs (created_at desc);

-- Ein Ergebnis pro Testdefinition und Lauf. Name, Typ, Endpoint und Modell werden
-- denormalisiert gespeichert, damit die Historie auch nach Änderungen stabil bleibt.
create table results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references runs (id) on delete cascade,
  test_id       uuid references test_definitions (id) on delete set null,
  test_name     text not null,
  type          text not null,
  endpoint_id   uuid references endpoints (id) on delete set null,
  endpoint_name text,
  model         text,
  persona_name  text,
  status        text not null check (status in ('running', 'passed', 'failed', 'error', 'skipped')),
  score         numeric,                          -- 0..1, sofern der Testtyp eine Bewertung liefert
  duration_ms   int,
  metrics       jsonb not null default '{}',      -- z. B. ttft_ms_p95, tokens_per_s, error_rate
  details       jsonb not null default '{}',      -- Einzelfälle, Antworten, Regressionsvergleich
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index results_run_idx on results (run_id);
create index results_test_finished_idx on results (test_id, finished_at desc);
create index results_type_finished_idx on results (type, finished_at desc);

create table run_logs (
  id        bigserial primary key,
  run_id    uuid not null references runs (id) on delete cascade,
  result_id uuid references results (id) on delete cascade,
  ts        timestamptz not null default now(),
  level     text not null default 'info',
  message   text not null,
  data      jsonb
);
create index run_logs_run_idx on run_logs (run_id, id);
