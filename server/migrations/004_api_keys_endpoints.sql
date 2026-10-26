-- API-Key-Sammlung, neue Endpoint-Arten mit Maintainer, Veröffentlichung und Dev/Prod,
-- erweiterter Modellkatalog. Test-Personas entfallen (Feature für später).

-- --- API-Keys ---------------------------------------------------------------
create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  secret_enc  text,                                  -- AES-256-GCM, Schlüssel aus APP_SECRET
  visibility  text not null default 'user' check (visibility in ('user', 'teams', 'global')),
  admin_only  boolean not null default false,        -- nur Administratoren sehen und nutzen den Key
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table api_key_teams (
  api_key_id uuid not null references api_keys (id) on delete cascade,
  team_id    uuid not null references teams (id) on delete cascade,
  primary key (api_key_id, team_id)
);

create table api_key_users (
  api_key_id uuid not null references api_keys (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  primary key (api_key_id, user_id)
);

-- --- Endpoints --------------------------------------------------------------
alter table endpoints drop constraint endpoints_kind_check;
update endpoints set kind = case kind when 'litellm' then 'ai_proxy' when 'mcp' then 'mcp' else 'llm' end;
alter table endpoints add constraint endpoints_kind_check check (kind in ('ai_proxy', 'llm', 'mcp'));

alter table endpoints
  add column llm_flavor text not null default 'openai' check (llm_flavor in ('openai', 'claude')),
  add column api_key_id uuid references api_keys (id) on delete set null,
  add column maintainer_id uuid references users (id) on delete set null,
  add column environment text not null default 'prod' check (environment in ('dev', 'prod')),
  add column visibility text not null default 'global' check (visibility in ('admins', 'teams', 'global'));

create table endpoint_teams (
  endpoint_id uuid not null references endpoints (id) on delete cascade,
  team_id     uuid not null references teams (id) on delete cascade,
  primary key (endpoint_id, team_id)
);

-- Bisherige Endpoint-Keys wandern in die Sammlung (nur für Administratoren sichtbar, Verhalten bleibt gleich).
do $$
declare
  e record;
  k uuid;
begin
  for e in select id, name, api_key_enc, created_by from endpoints where api_key_enc is not null loop
    insert into api_keys (name, description, secret_enc, visibility, admin_only, created_by)
      values ('Endpoint: ' || e.name, 'Aus dem Endpoint "' || e.name || '" übernommen', e.api_key_enc, 'global', true, e.created_by)
      returning id into k;
    update endpoints set api_key_id = k where id = e.id;
  end loop;
end $$;
alter table endpoints drop column api_key_enc;

-- --- Modellkatalog ----------------------------------------------------------
alter table endpoint_models
  add column maintainer_id uuid references users (id) on delete set null,
  add column environment text not null default 'prod' check (environment in ('dev', 'prod')),
  add column visibility text not null default 'global' check (visibility in ('admins', 'teams', 'global'));

create table model_teams (
  endpoint_id uuid not null,
  model_name  text not null,
  team_id     uuid not null references teams (id) on delete cascade,
  primary key (endpoint_id, model_name, team_id),
  foreign key (endpoint_id, model_name) references endpoint_models (endpoint_id, name) on delete cascade on update cascade
);

-- --- Personas -> API-Keys ---------------------------------------------------
-- Persona-Keys behalten ihren Namen, damit Verweise in Testkonfigurationen weiter funktionieren.
alter table test_definitions add column api_key_id uuid references api_keys (id) on delete set null;

insert into api_keys (name, description, secret_enc, visibility, admin_only)
  select name, description, secret_enc, 'global', true from personas where auth_type = 'api_key' and secret_enc is not null
  on conflict (name) do nothing;

update test_definitions t set api_key_id = k.id
  from personas p join api_keys k on k.name = p.name
  where t.persona_id = p.id and p.auth_type = 'api_key';

alter table results rename column persona_name to api_key_name;
alter table test_definitions drop column persona_id;
drop table personas;

update roles set permissions = array_remove(permissions, 'personas.manage');
