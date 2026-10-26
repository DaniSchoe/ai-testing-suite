-- 0.4.0: Ziel = Plattform mit Komponenten (Gateway, Inferenz, MCP, Vektor-DB, IAM, Observability), Topologie,
-- Modellmetadaten und Plattform-Snapshot. Das Sizing (Cluster-Builder) hängt an der Plattform.

create table platforms (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  name         text not null,
  description  text,
  environment  text not null default 'prod' check (environment in ('dev', 'prod')),
  -- Souveränitätsprofil: { min_level: 0..4, goals: { "SOV-1": { level: 0..4, note } } }
  sovereignty  jsonb not null default '{}',
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table endpoints add column platform_id uuid references platforms (id) on delete cascade;
alter table endpoints drop constraint endpoints_kind_check;
alter table endpoints add constraint endpoints_kind_check
  check (kind in ('ai_proxy', 'llm', 'mcp', 'vector_db', 'iam', 'observability'));
alter table endpoints add column health_path text;     -- für Komponenten ohne Modellliste: Pfad der Statusabfrage

-- Bestehende Endpoints je Mandant und Umgebung in eine Plattform überführen.
insert into platforms (tenant_id, name, description, environment)
  select distinct e.tenant_id, 'Plattform ' || case e.environment when 'prod' then '(Prod)' else '(Dev)' end,
         'Aus den bisherigen Endpoints übernommen', e.environment
  from endpoints e;
update endpoints e set platform_id = p.id
  from platforms p where p.tenant_id = e.tenant_id and p.environment = e.environment;
alter table endpoints alter column platform_id set not null;
create index endpoints_platform_idx on endpoints (platform_id);

-- Topologie: welcher Gateway-Endpunkt routet auf welche Backends (Modellnamen optional).
create table platform_routes (
  id                  uuid primary key default gen_random_uuid(),
  platform_id         uuid not null references platforms (id) on delete cascade,
  gateway_endpoint_id uuid not null references endpoints (id) on delete cascade,
  backend_endpoint_id uuid not null references endpoints (id) on delete cascade,
  models              text[] not null default '{}',
  note                text,
  unique (gateway_endpoint_id, backend_endpoint_id)
);
create index platform_routes_platform_idx on platform_routes (platform_id);

-- Sizing (Schätzung) je Plattform statt einer globalen Konfiguration.
create table platform_sizing (
  platform_id uuid primary key references platforms (id) on delete cascade,
  config      jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users (id) on delete set null
);
insert into platform_sizing (platform_id, config, updated_at, updated_by)
  select p.id, c.config, c.updated_at, c.updated_by
  from platform_config c
  cross join lateral (select id from platforms order by (environment = 'prod') desc, created_at limit 1) p;
drop table platform_config;

-- Modellkatalog: Metadaten für Souveränität, Voraussetzungen und Berichte.
alter table endpoint_models
  add column license text,
  add column provider text,
  add column origin text,                      -- Herkunft, z. B. Land oder Organisation
  add column open_weights boolean,
  add column revision text,                    -- Revision bzw. Hash der Gewichte
  add column quantization text,
  add column capabilities text[] not null default '{}',   -- vision, tools, reasoning, mcp, json
  add column context_length int,
  add column info jsonb not null default '{}';            -- zuletzt abgefragte Rohdaten (z. B. root, max_model_len)

-- Läufe merken sich die Plattform und deren Zustand zum Zeitpunkt der Prüfung.
alter table runs add column platform_id uuid references platforms (id) on delete set null;
alter table runs add column snapshot jsonb;
