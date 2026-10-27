-- 0.6.0: Server und Interconnect im Inventar, Topologie in festen Ebenen, Routen mit Modellzuordnung, Abteilungen.
alter table endpoints drop constraint endpoints_kind_check;
alter table endpoints add constraint endpoints_kind_check
  check (kind in ('ai_proxy', 'llm', 'mcp', 'vector_db', 'iam', 'observability', 'datacenter', 'kubernetes', 'gpu', 'server', 'interconnect'));

-- Route: Modell am Gateway -> Modell am Inferenzdienst (beliebig viele Zuordnungen je Gateway und Inferenzdienst).
alter table platform_routes add column mappings jsonb not null default '[]';
update platform_routes set mappings = coalesce((select jsonb_agg(jsonb_build_object('gateway_model', m, 'backend_model', m)) from unnest(models) m), '[]'::jsonb);

-- Organisation: Mandant -> Abteilung -> Team.
create table departments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table teams add column department_id uuid references departments (id) on delete set null;
