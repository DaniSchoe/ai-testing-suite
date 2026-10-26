-- Plattform-Analyse: eine gemeinsame Konfiguration (Cluster, Annahmen, Metrik-Endpunkte).
create table platform_config (
  id         int primary key check (id = 1),
  config     jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete set null
);
