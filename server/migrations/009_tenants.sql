-- 0.4.0: Mandanten als oberste Trennung, Rollen pro Mandant, neue Berechtigungen, Audit-Log, Service-Tokens.

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now()
);
insert into tenants (key, name, description) values ('default', 'Standard', 'Bestehende Daten vor Einführung der Mandanten');

-- Rollen werden je Mandant vergeben (tenant_id); ohne Mandant gilt die Rolle überall (System-Administratoren).
alter table user_roles add column tenant_id uuid references tenants (id) on delete cascade;
alter table user_roles drop constraint user_roles_pkey;
create unique index user_roles_unique_idx on user_roles (user_id, role_id, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index user_roles_tenant_idx on user_roles (tenant_id);
-- Die Administrator-Rolle bleibt global (System-Administrator), alle anderen Zuordnungen gehören zum Standard-Mandanten.
update user_roles ur set tenant_id = (select id from tenants where key = 'default')
  from roles r where r.id = ur.role_id and r.key is distinct from 'admin';

-- Mandantenbezogene Objekte.
alter table teams add column tenant_id uuid references tenants (id) on delete cascade;
alter table api_keys add column tenant_id uuid references tenants (id) on delete cascade;
alter table endpoints add column tenant_id uuid references tenants (id) on delete cascade;
alter table tests add column tenant_id uuid references tenants (id) on delete cascade;
alter table runs add column tenant_id uuid references tenants (id) on delete cascade;
alter table schedules add column tenant_id uuid references tenants (id) on delete cascade;

update teams set tenant_id = (select id from tenants where key = 'default');
update api_keys set tenant_id = (select id from tenants where key = 'default');
update endpoints set tenant_id = (select id from tenants where key = 'default');
update tests set tenant_id = (select id from tenants where key = 'default');
update runs set tenant_id = (select id from tenants where key = 'default');
update schedules set tenant_id = (select id from tenants where key = 'default');

alter table teams alter column tenant_id set not null;
alter table api_keys alter column tenant_id set not null;
alter table endpoints alter column tenant_id set not null;
alter table tests alter column tenant_id set not null;
alter table runs alter column tenant_id set not null;
alter table schedules alter column tenant_id set not null;

-- Namen sind nur noch je Mandant eindeutig.
alter table teams drop constraint teams_name_key;
alter table api_keys drop constraint api_keys_name_key;
alter table endpoints drop constraint endpoints_name_key;
alter table teams add constraint teams_tenant_name_key unique (tenant_id, name);
alter table api_keys add constraint api_keys_tenant_name_key unique (tenant_id, name);
alter table endpoints add constraint endpoints_tenant_name_key unique (tenant_id, name);

create index runs_tenant_created_idx on runs (tenant_id, created_at desc);

-- Neue Rollen und Berechtigungen. Bestehende Rollen behalten ihre Schlüssel (tester, viewer).
update roles set name = 'Test Engineer', description = 'Datensätze, Vorlagen und Prüfungen pflegen und ausführen'
  where key = 'tester';
update roles set name = 'Kunden-Viewer', description = 'Plattform- und Berichtsebene ohne Rohdaten aus Angriffen'
  where key = 'viewer';
update roles set permissions = '{suite.view,results.view_all,tests.manage,runs.start,schedules.manage}' where key = 'tester';

insert into roles (key, name, description, permissions) values
  ('engagement_lead', 'Engagement Lead', 'Verantwortet Prüfungen eines Mandanten: Freigaben für Prod, Berichte, Findings, Mitglieder',
   '{suite.view,results.view_all,tests.manage,runs.start,schedules.manage,runs.manage_all,runs.prod,reports.approve,findings.manage,catalog.publish,endpoints.manage,users.manage,teams.manage}'),
  ('red_teamer', 'Red Teamer', 'Sieht Angriffs-Payloads, pflegt Security-Vorlagen und Findings',
   '{suite.view,results.view_all,tests.manage,runs.start,security.payloads,findings.manage}'),
  ('reviewer', 'Reviewer', 'Gibt Vorlagen, Pakete und Prüfberichte frei',
   '{suite.view,results.view_all,catalog.publish,reports.approve,findings.manage}'),
  ('service', 'Service Account', 'Technischer Zugang für CI/CD: Prüfungen starten und Ergebnis lesen',
   '{suite.view,runs.start}');

-- Audit-Log (Administration).
create table audit_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  tenant_id   uuid references tenants (id) on delete set null,
  user_id     uuid references users (id) on delete set null,
  user_name   text,
  action      text not null,
  object_type text,
  object_id   text,
  details     jsonb not null default '{}'
);
create index audit_log_ts_idx on audit_log (ts desc);
create index audit_log_tenant_idx on audit_log (tenant_id, ts desc);

-- Service-Tokens für CI/CD und CLI. Je Token gibt es einen technischen User mit der Rolle "Service Account" im Mandanten.
create table service_tokens (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  name         text not null,
  prefix       text not null,
  token_hash   text not null unique,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
create index service_tokens_tenant_idx on service_tokens (tenant_id);
