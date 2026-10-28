-- Bearer-Token von MCP-Servern (verschlüsselt), unabhängig von den API-Keys.
alter table endpoints add column auth_token_enc text;
update endpoints e set auth_token_enc = k.secret_enc, spec = jsonb_set(coalesce(e.spec, '{}'::jsonb), '{auth}', '{"type":"bearer"}')
  from api_keys k where e.kind = 'mcp' and k.id = e.api_key_id;
update endpoints set spec = jsonb_set(coalesce(spec, '{}'::jsonb), '{auth}', '{"type":"none"}') where kind = 'mcp' and not (coalesce(spec, '{}'::jsonb) ? 'auth');

-- Modellportfolio: Parameterzahl und welche Metadaten die KI vorbefüllt hat.
alter table portfolio_models add column parameters_b numeric;
alter table portfolio_models add column ai_filled text[] not null default '{}';

-- Zeitreihe der Metriken je Komponente (ausgewählte Kennzahlen aus den Prometheus-Endpunkten).
create table metric_samples (
  endpoint_id uuid not null references endpoints (id) on delete cascade,
  at          timestamptz not null default now(),
  values      jsonb not null
);
create index metric_samples_idx on metric_samples (endpoint_id, at desc);
