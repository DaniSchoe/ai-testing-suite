-- 0.4.0: Prüfung (Audit) ersetzt den Test-Builder: Ziel (Plattform), Vorlagen/Pakete in fester Version, Modelle mit Pfad,
-- Keys, Schwellwerte, Wiederholungen, Vergleichsmodus, Baseline, Freigaben und Zeitplan. test_definitions und results bleiben
-- die Ausführungsebene. Bestehende Tests werden in 014_convert_tests.js überführt (IDs bleiben erhalten).

alter table tests rename to audits;
alter table test_teams rename to audit_teams;
alter table audit_teams rename column test_id to audit_id;
drop table test_watchlist;

alter table audits rename column models to models_old;
alter table audits
  add column platform_id        uuid references platforms (id) on delete set null,
  add column models             jsonb not null default '[]',      -- [{ alias, path: direct | gateway | both }]
  add column items              jsonb not null default '[]',      -- [{ template_version_id, pack_version_id, endpoint_id, thresholds: [{ metric, op, value }] }]
  add column repeats            int not null default 1,
  add column mode               text not null default 'standard' check (mode in ('standard', 'compare')),
  add column compare            jsonb,                            -- { kind: models | paths, a, b, model }
  add column regression_tolerance numeric not null default 0.2,
  add column baseline_run_id    uuid,
  add column baseline_auto      boolean not null default false,
  add column baseline_set_by    uuid references users (id) on delete set null,
  add column baseline_set_at    timestamptz,
  add column load_limits        jsonb not null default '{}',      -- { max_concurrency, max_duration_s } für Lasttests
  add column gate               jsonb not null default '{}';      -- CI/CD: { fail_on: [security_finding, quality_deviation, technical_error] }

alter table test_definitions rename column build_id to audit_id;
alter table test_definitions rename column build_key to atom_key;
alter table test_definitions
  add column template_version_id uuid references template_versions (id) on delete set null,
  add column variant text,
  add column item_index int;

alter table runs rename column build_id to audit_id;
alter table runs drop constraint runs_kind_check;
alter table runs drop column suite_id;
update runs set kind = 'audit' where kind = 'build';
update runs set kind = 'selection' where kind = 'suite';
alter table runs add constraint runs_kind_check check (kind in ('single', 'selection', 'all', 'audit', 'draft', 'retest'));
alter table runs
  add column is_draft      boolean not null default false,        -- Entwurfsläufe von Vorlagen zählen nicht in Historie und Dashboard
  add column outcomes      jsonb not null default '{}',
  add column comparison    jsonb,
  add column evidence_hash text,
  add column repeats       int not null default 1,
  add column approval_id   uuid,
  add column gate          jsonb;
alter table audits add constraint audits_baseline_fk foreign key (baseline_run_id) references runs (id) on delete set null;

alter table schedules rename column build_id to audit_id;
alter table schedules drop constraint schedules_target_kind_check;
delete from schedules where target_kind in ('all', 'test') and audit_id is null;
update schedules set target_kind = 'audit';
alter table schedules add constraint schedules_target_kind_check check (target_kind = 'audit');
alter table schedules drop column test_id;
alter table schedules drop column suite_id;
drop table suite_tests;
drop table suites;

alter table results
  add column template_version_id uuid references template_versions (id) on delete set null,
  add column template_key       text,
  add column template_version   text,
  add column audit_id           uuid references audits (id) on delete set null,
  add column platform_id        uuid references platforms (id) on delete set null,
  add column variant            text,                              -- A | B im Vergleichsmodus
  add column path               text,                              -- direct | gateway
  add column outcome            text check (outcome in ('passed', 'quality_deviation', 'security_finding', 'technical_error', 'not_applicable')),
  add column attempts           int not null default 1,
  add column sensitivity        text not null default 'internal',
  add column statistics         jsonb;
update results set outcome = case status
  when 'passed' then 'passed'
  when 'error' then 'technical_error'
  when 'skipped' then 'not_applicable'
  else case when type in ('security', 'access', 'mcp') then 'security_finding' else 'quality_deviation' end end
  where status <> 'running';
create index results_template_idx on results (template_version_id);
create index results_audit_idx on results (audit_id, finished_at desc);
create index results_platform_idx on results (platform_id, finished_at desc);

-- Freigaben für Prod-Ziele und Lasttests (Vier-Augen-Prinzip, Zeitfenster, Obergrenzen).
create table approvals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  audit_id      uuid not null references audits (id) on delete cascade,
  platform_id   uuid references platforms (id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked')),
  requested_by  uuid references users (id) on delete set null,
  request_note  text,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references users (id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  window_from   timestamptz,
  window_to     timestamptz,
  limits        jsonb not null default '{}',                      -- { max_concurrency, max_duration_s }
  runs_allowed  int not null default 1,
  runs_used     int not null default 0
);
create index approvals_tenant_idx on approvals (tenant_id, status);
create index approvals_audit_idx on approvals (audit_id);

-- Kill-Switch je Plattform: gesperrte Plattformen starten keine Läufe, laufende werden abgebrochen.
alter table platforms
  add column locked        boolean not null default false,
  add column locked_reason text,
  add column locked_by     uuid references users (id) on delete set null,
  add column locked_at     timestamptz;

alter table runs add constraint runs_approval_fk foreign key (approval_id) references approvals (id) on delete set null;
