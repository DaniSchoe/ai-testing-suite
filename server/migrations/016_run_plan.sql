-- 0.4.0: Ein Lauf trägt seinen Plan (Einzeltests aus Vorlage × Modell × Pfad) selbst. Die Einzeltest-Tabelle entfällt.
alter table runs add column plan jsonb not null default '[]';
alter table runs drop column test_ids;
alter table runs add column template_version_id uuid references template_versions (id) on delete set null;  -- Entwurfsläufe einer Vorlage
alter table results drop column test_id;
drop table test_definitions;
alter table results add column item_index int;

-- Security-Vorlagen haben eine eigene Freigabestufe (zweite Freigabe durch jemanden mit security.payloads).
alter table template_versions
  add column security_reviewed_by uuid references users (id) on delete set null,
  add column security_reviewed_at timestamptz;
