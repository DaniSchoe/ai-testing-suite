-- Modellkatalog: Modelle werden pro Endpoint über /v1/models abgefragt. vLLM und LiteLLM
-- benennen dasselbe Modell oft unterschiedlich; ein manuell gepflegter Alias führt sie zusammen.
create table endpoint_models (
  endpoint_id   uuid not null references endpoints (id) on delete cascade,
  name          text not null,                  -- Name, wie der Endpoint ihn erwartet
  alias         text,                           -- gemeinsamer Name über Endpoints hinweg (leer = name)
  source        text not null default 'discovered' check (source in ('discovered', 'manual')),
  available     boolean not null default true,  -- beim letzten Abruf noch gelistet?
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  primary key (endpoint_id, name)
);
create index endpoint_models_alias_idx on endpoint_models (alias);

insert into endpoint_models (endpoint_id, name, source)
select id, unnest(models), 'manual' from endpoints;

alter table endpoints drop column models;
alter table endpoints add column auto_discover boolean not null default true;
alter table endpoints add column models_synced_at timestamptz;
alter table endpoints add column models_sync_error text;

-- Ergebnisse merken sich zusätzlich den Alias, damit Auswertungen endpointübergreifend gruppieren.
alter table results add column model_alias text;
update results set model_alias = model;
create index results_alias_finished_idx on results (model_alias, finished_at desc);
