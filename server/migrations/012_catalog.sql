-- 0.4.0: Testkatalog: Kategorien (OWASP, AIC4, SOV, eigene), Vorlagen und Prüfpakete mit semantischer Versionierung,
-- Freigabeprozess (Entwurf, Review, veröffentlicht, veraltet) und Herkunft (offiziell, Team, privat).

create table categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants (id) on delete cascade,        -- leer = global
  framework   text not null,                                         -- z. B. OWASP LLM Top 10, AIC4, SOV, oder frei
  key         text not null,                                         -- z. B. LLM01, SR, SOV-3
  name        text not null,
  description text,
  builtin     boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index categories_key_idx on categories (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), framework, key);

create table templates (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  tenant_id   uuid references tenants (id) on delete cascade,        -- leer = offiziell
  origin      text not null check (origin in ('official', 'team', 'private')),
  team_id     uuid references teams (id) on delete set null,
  owner_id    uuid references users (id) on delete set null,
  name        text not null,
  description text,
  type        text not null,
  tags        text[] not null default '{}',
  use_cases   text[] not null default '{}',                          -- chat, coding, ocr, agent: speist die Eignung im Dashboard
  security    boolean not null default false,                        -- eigene Freigabestufe, Angriffsinhalte
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index templates_key_idx on templates (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- spec: { config, dataset: { key, version } | null, requires: [vision, tools, ...], params, repeats, scoring, output,
--         suggested_thresholds: [...], example_result }
create table template_versions (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references templates (id) on delete cascade,
  version       text not null,
  status        text not null default 'draft' check (status in ('draft', 'review', 'published', 'deprecated')),
  spec          jsonb not null default '{}',
  changelog     text,
  hash          text not null,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  submitted_by  uuid references users (id) on delete set null,
  submitted_at  timestamptz,
  reviewed_by   uuid references users (id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text,
  published_at  timestamptz,
  unique (template_id, version)
);

create table template_version_categories (
  version_id  uuid not null references template_versions (id) on delete cascade,
  category_id uuid not null references categories (id) on delete cascade,
  primary key (version_id, category_id)
);

create table packs (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  tenant_id   uuid references tenants (id) on delete cascade,
  origin      text not null check (origin in ('official', 'team', 'private')),
  team_id     uuid references teams (id) on delete set null,
  owner_id    uuid references users (id) on delete set null,
  name        text not null,
  description text,
  framework   text,                                                  -- Bezug, z. B. OWASP LLM Top 10
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index packs_key_idx on packs (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- items: [{ template_id, template_key, version }] mit fest verankerten Versionen
create table pack_versions (
  id            uuid primary key default gen_random_uuid(),
  pack_id       uuid not null references packs (id) on delete cascade,
  version       text not null,
  status        text not null default 'draft' check (status in ('draft', 'review', 'published', 'deprecated')),
  items         jsonb not null default '[]',
  changelog     text,
  hash          text not null,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  submitted_by  uuid references users (id) on delete set null,
  submitted_at  timestamptz,
  reviewed_by   uuid references users (id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text,
  published_at  timestamptz,
  unique (pack_id, version)
);
