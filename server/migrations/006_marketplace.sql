-- Marketplace: Merkliste, eigener API-Key beim Ausführen veröffentlichter Tests.
alter table tests add column requires_api_key boolean not null default false;   -- Nutzer führen den Test mit ihrem eigenen Key aus
alter table runs add column api_key_id uuid references api_keys (id) on delete set null;

create table test_watchlist (
  test_id    uuid not null references tests (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (test_id, user_id)
);
