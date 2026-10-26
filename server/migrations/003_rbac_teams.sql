-- Rollen, Berechtigungen und Teams werden in der Anwendung gepflegt statt in Keycloak.
-- Keycloak liefert nur noch die Identität (sub, Name, E-Mail).

create table roles (
  id          uuid primary key default gen_random_uuid(),
  key         text unique,                      -- feste Kennung der mitgelieferten Rollen
  name        text not null unique,
  description text,
  permissions text[] not null default '{}',
  is_default  boolean not null default false,   -- erhalten neue User beim ersten Login
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index roles_single_default_idx on roles (is_default) where is_default;

insert into roles (key, name, description, permissions, is_default) values
  ('admin', 'Administrator', 'Voller Zugriff, Berechtigungen nicht änderbar', '{}', false),
  ('tester', 'Tester', 'Tests, Suiten und Zeitpläne pflegen und ausführen',
   '{suite.view,results.view_all,tests.manage,runs.start,schedules.manage}', false),
  ('viewer', 'Betrachter', 'Dashboard und Ergebnisse ansehen',
   '{suite.view,results.view_all}', true);

create table user_roles (
  user_id    uuid not null references users (id) on delete cascade,
  role_id    uuid not null references roles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

create table team_members (
  team_id    uuid not null references teams (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on team_members (user_id);

-- Bisherige Rollen aus Keycloak übernehmen.
insert into user_roles (user_id, role_id)
  select u.id, r.id from users u cross join lateral unnest(u.roles) as ur(key) join roles r on r.key = ur.key
  on conflict do nothing;
alter table users drop column roles;

-- Admins können User vorab per E-Mail anlegen (Rollen/Teams zuweisen), sub wird beim ersten Login gesetzt.
alter table users alter column sub drop not null;
alter table users add column email_verified boolean not null default false;
alter table users add column disabled boolean not null default false;
create unique index users_email_pending_idx on users (lower(email)) where sub is null;
