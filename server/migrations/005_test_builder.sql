-- Test-Builder: ein "Test" bündelt beliebig viele Testarten, Modelle und den Zeitplan.
-- Die ausführbaren Einzeltests (test_definitions) werden daraus erzeugt und gehören dem Test.

create table tests (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  tags          text[] not null default '{}',
  maintainer_id uuid references users (id) on delete set null,
  endpoint_id   uuid references endpoints (id) on delete cascade,
  models        text[] not null default '{}',          -- Alias oder Name; leer = Standardmodell des Endpoints
  api_key_id    uuid references api_keys (id) on delete set null,
  types         text[] not null default '{}',
  configs       jsonb not null default '{}',           -- Konfiguration je Testart: { "<type>": { ... } }
  visibility    text not null default 'private' check (visibility in ('private', 'teams', 'global')),
  published_at  timestamptz,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index tests_created_by_idx on tests (created_by);

create table test_teams (
  test_id uuid not null references tests (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  primary key (test_id, team_id)
);

alter table test_definitions
  add column build_id  uuid references tests (id) on delete cascade,
  add column build_key text;
create index test_definitions_build_idx on test_definitions (build_id);

-- Läufe und Zeitpläne können einen Test als Ziel haben; einmalige Zeitpunkte statt Cron.
alter table runs drop constraint runs_kind_check;
alter table runs add constraint runs_kind_check check (kind in ('single', 'selection', 'suite', 'all', 'build'));
alter table runs add column build_id uuid references tests (id) on delete set null;

alter table schedules drop constraint schedules_target_kind_check;
alter table schedules add constraint schedules_target_kind_check check (target_kind in ('test', 'suite', 'all', 'build'));
alter table schedules
  add column build_id uuid references tests (id) on delete cascade,
  add column run_at timestamptz,
  alter column cron drop not null,
  add constraint schedules_when_check check (cron is not null or run_at is not null);

-- --- Bestand überführen -------------------------------------------------------
-- Suiten, deren Einzeltests auf demselben Endpoint liegen und unterschiedliche Typen haben,
-- werden zu einem Test. Alle übrigen Einzeltests werden je ein eigener Test. Bisher sahen alle User
-- alle Tests, deshalb sind migrierte Tests global sichtbar.
do $$
declare
  s record;
  t record;
  new_id uuid;
begin
  for s in
    select su.id, su.name, su.description, su.created_by,
           min(td.endpoint_id::text)::uuid as endpoint_id,
           min(td.api_key_id::text)::uuid as api_key_id
    from suites su
    join suite_tests st on st.suite_id = su.id
    join test_definitions td on td.id = st.test_id
    group by su.id
    having count(*) >= 2
       and count(distinct td.endpoint_id) = 1
       and count(distinct td.type) = count(*)
       and count(distinct td.api_key_id) <= 1
  loop
    insert into tests (name, description, tags, maintainer_id, endpoint_id, models, api_key_id, types, configs, visibility, created_by)
    select s.name, s.description, array[]::text[], s.created_by, s.endpoint_id,
           coalesce((select array_agg(distinct td.config ->> 'model') filter (where td.config ->> 'model' is not null)
                     from suite_tests st join test_definitions td on td.id = st.test_id where st.suite_id = s.id), '{}'),
           s.api_key_id,
           array_agg(td.type order by st.position, td.name),
           jsonb_object_agg(td.type, td.config - 'model'),
           'global', s.created_by
    from suite_tests st join test_definitions td on td.id = st.test_id
    where st.suite_id = s.id
    returning id into new_id;

    update test_definitions td set build_id = new_id,
           build_key = coalesce(td.config ->> 'model', '')
      from suite_tests st where st.test_id = td.id and st.suite_id = s.id;
    update schedules set target_kind = 'build', build_id = new_id, suite_id = null where target_kind = 'suite' and suite_id = s.id;
  end loop;

  for t in select * from test_definitions where build_id is null loop
    insert into tests (name, tags, maintainer_id, endpoint_id, models, api_key_id, types, configs, visibility, created_by)
    values (t.name, t.tags, t.created_by, t.endpoint_id,
            case when t.config ->> 'model' is not null then array[t.config ->> 'model'] else '{}' end,
            t.api_key_id, array[t.type], jsonb_build_object(t.type, t.config - 'model'), 'global', t.created_by)
    returning id into new_id;
    update test_definitions set build_id = new_id, build_key = coalesce(t.config ->> 'model', '') where id = t.id;
    update schedules set target_kind = 'build', build_id = new_id, test_id = null where target_kind = 'test' and test_id = t.id;
  end loop;
end $$;
