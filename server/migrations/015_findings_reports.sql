-- 0.4.0: Findings, revisionssichere Nachweise (Evidence) und Prüfberichte.

create table findings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  platform_id   uuid references platforms (id) on delete cascade,
  audit_id      uuid references audits (id) on delete set null,
  fingerprint   text not null,                                      -- Plattform, Vorlage, Fall, Modell und Pfad: dasselbe Problem wird nicht doppelt angelegt
  title         text not null,
  description   text,
  severity      text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  framework     text,
  category      text,
  template_key  text,
  case_name     text,
  model         text,
  path          text,
  status        text not null default 'open' check (status in ('open', 'in_progress', 'accepted', 'fixed', 'closed')),
  owner_id      uuid references users (id) on delete set null,
  evidence      jsonb,                                              -- { prompt, response, assessment, hash }
  first_run_id  uuid references runs (id) on delete set null,
  last_run_id   uuid references runs (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  occurrences   int not null default 1,
  retest_run_id uuid references runs (id) on delete set null,
  retest_result text check (retest_result in ('fixed', 'still_failing')),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, fingerprint)
);
create index findings_tenant_status_idx on findings (tenant_id, status);
create index findings_platform_idx on findings (platform_id);

create table finding_events (
  id         bigserial primary key,
  finding_id uuid not null references findings (id) on delete cascade,
  ts         timestamptz not null default now(),
  user_id    uuid references users (id) on delete set null,
  kind       text not null,
  data       jsonb not null default '{}'
);
create index finding_events_idx on finding_events (finding_id, ts);

-- Prompt, Antwort und Bewertung je Testfall mit Hash. Nach Ablauf der Aufbewahrungsfrist wird der Inhalt gelöscht, Hash und Metadaten bleiben.
create table evidence (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  run_id       uuid not null references runs (id) on delete cascade,
  result_id    uuid not null references results (id) on delete cascade,
  case_key     text not null,
  prompt       text,
  response     text,
  assessment   jsonb,
  ok           boolean,
  hash         text not null,
  sensitivity  text not null default 'internal',
  retain_until timestamptz,
  purged_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index evidence_run_idx on evidence (run_id);
create index evidence_result_idx on evidence (result_id);
create index evidence_retain_idx on evidence (retain_until) where purged_at is null;

create table reports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  audit_id      uuid references audits (id) on delete cascade,
  run_id        uuid not null unique references runs (id) on delete cascade,
  status        text not null default 'draft' check (status in ('draft', 'in_review', 'approved')),
  summary       text,                                               -- Management Summary (vom Reviewer bearbeitet)
  ai_draft      text,                                               -- Entwurf der KI-Analyse, nie automatisch freigegeben
  body          jsonb not null default '{}',                        -- Bewertungen, Findings, Frameworkbezug, Snapshot (zum Zeitpunkt der Erstellung)
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  submitted_by  uuid references users (id) on delete set null,
  submitted_at  timestamptz,
  approved_by   uuid references users (id) on delete set null,
  approved_at   timestamptz,
  approval_note text
);
create index reports_tenant_idx on reports (tenant_id, created_at desc);
