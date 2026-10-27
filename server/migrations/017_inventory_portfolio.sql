-- 0.5.0: Plattform-Inventar (Rechenzentrum, Kubernetes, GPU-Server, Inferenzserver, AI Gateway), Topologie mit Zuordnungen,
-- Modellportfolio, Vorlagen ohne Pakete und Security-Flag (mit Test-Ziel), Freigaben mit Zuweisung.

-- --- Inventar ----------------------------------------------------------------------------------------------------
alter table endpoints drop constraint endpoints_kind_check;
alter table endpoints add constraint endpoints_kind_check
  check (kind in ('ai_proxy', 'llm', 'mcp', 'vector_db', 'iam', 'observability', 'datacenter', 'kubernetes', 'gpu'));
alter table endpoints alter column base_url drop not null;
alter table endpoints add column spec jsonb not null default '{}';     -- typspezifische Angaben (Anbieter, Region, Zertifikate, GPU-Typ, MIG, gehostete Modelle …)
alter table endpoints add column metrics_url text;                     -- optional: DCGM- bzw. Prometheus-Endpunkt

-- Topologie: Zuordnung der Komponenten untereinander. Routen (Gateway -> Inferenz) bleiben in platform_routes.
--   hosted_in: GPU-Server oder Kubernetes -> Rechenzentrum
--   cluster:   GPU-Server -> Kubernetes (Knoten gehört zum Cluster)
--   runs_on:   Inferenzserver -> GPU-Server, data { mig_slice: n } wenn nur eine MIG-Instanz genutzt wird
create table platform_links (
  id          uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms (id) on delete cascade,
  kind        text not null check (kind in ('hosted_in', 'cluster', 'runs_on')),
  from_id     uuid not null references endpoints (id) on delete cascade,
  to_id       uuid not null references endpoints (id) on delete cascade,
  data        jsonb not null default '{}'
);
create unique index platform_links_unique_idx on platform_links (kind, from_id, to_id, coalesce(data ->> 'mig_slice', ''));
create index platform_links_platform_idx on platform_links (platform_id);

alter table platforms add column layout jsonb not null default '{}';   -- Positionen der Knoten im Topologie-Editor

-- --- Souveränität: erklärte Stufen entfallen, Überschreibungen mit Begründung kommen -------------------------------------
update platforms set sovereignty = jsonb_build_object('min_level', coalesce((sovereignty ->> 'min_level')::int, 2), 'overrides', '{}'::jsonb);

-- --- Modellportfolio -----------------------------------------------------------------------------------------------
create table portfolio_models (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  name          text not null,
  description   text,
  provider      text,
  license       text,
  origin        text,
  open_weights  boolean,
  revision      text,
  quantization  text,
  capabilities  text[] not null default '{}',
  context_length int,
  maintainer_id uuid references users (id) on delete set null,
  visibility    text not null default 'global' check (visibility in ('admins', 'teams', 'global')),
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, name)
);
create table portfolio_model_teams (
  portfolio_id uuid not null references portfolio_models (id) on delete cascade,
  team_id      uuid not null references teams (id) on delete cascade,
  primary key (portfolio_id, team_id)
);
alter table endpoint_models add column portfolio_id uuid references portfolio_models (id) on delete set null;
create index endpoint_models_portfolio_idx on endpoint_models (portfolio_id);

-- Bestehende Modelle je Mandant und Alias in das Portfolio übernehmen (Metadaten vom vollständigsten Eintrag).
insert into portfolio_models (tenant_id, name, provider, license, origin, open_weights, revision, quantization, capabilities, context_length, maintainer_id, visibility)
select distinct on (e.tenant_id, coalesce(m.alias, m.name))
  e.tenant_id, coalesce(m.alias, m.name), m.provider, m.license, m.origin, m.open_weights, m.revision, m.quantization,
  m.capabilities, m.context_length, m.maintainer_id, m.visibility
from endpoint_models m join endpoints e on e.id = m.endpoint_id
order by e.tenant_id, coalesce(m.alias, m.name), (m.license is not null) desc, (m.provider is not null) desc, m.created_at;

update endpoint_models m set portfolio_id = p.id, alias = p.name
  from endpoints e, portfolio_models p
  where e.id = m.endpoint_id and p.tenant_id = e.tenant_id and p.name = coalesce(m.alias, m.name);

insert into portfolio_model_teams (portfolio_id, team_id)
select distinct m.portfolio_id, mt.team_id
from model_teams mt join endpoint_models m on m.endpoint_id = mt.endpoint_id and m.name = mt.model_name
where m.portfolio_id is not null;

-- --- Freigaben: Zuweisung an ein Team oder eine Person -------------------------------------------------------------------
alter table approvals add column assigned_team_id uuid references teams (id) on delete set null;
alter table approvals add column assigned_user_id uuid references users (id) on delete set null;

-- --- Vorlagen: Test-Ziel, keine Pakete, kein Security-Flag ----------------------------------------------------------
alter table templates add column target text not null default 'llm' check (target in ('platform', 'llm', 'data', 'process'));
update templates set target = 'platform' where type in ('smoke', 'load', 'access', 'mcp');
alter table templates drop column security;
alter table template_versions drop column security_reviewed_by, drop column security_reviewed_at;

update audits set items = coalesce((select jsonb_agg(i - 'pack_version_id') from jsonb_array_elements(items) i), '[]'::jsonb)
  where items::text like '%pack_version_id%';
drop table pack_versions;
drop table packs;
