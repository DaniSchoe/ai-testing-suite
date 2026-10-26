-- 0.3.0: Modell-Vergleich entfällt, Rate-Limits sind keine eigene Testart mehr (der Lasttest meldet HTTP 429 mit).
-- Bestehende Ergebnisse, Einzeltests und Testarten dieser Typen werden entfernt; Tests ohne verbleibende Testart ebenso.
delete from results where type in ('comparison', 'ratelimit');
delete from test_definitions where type in ('comparison', 'ratelimit');
update tests
   set types = array_remove(array_remove(types, 'comparison'), 'ratelimit'),
       configs = configs - 'comparison' - 'ratelimit'
 where types && array['comparison', 'ratelimit'];
delete from tests where cardinality(types) = 0;

-- Einstellungen der Anwendung (z. B. das Modell für die KI-Analyse).
create table app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete set null
);

-- KI-Analyse je Testlauf: { text, model, endpoint, generated_at }
alter table runs
  add column analysis        jsonb,
  add column analysis_status text check (analysis_status in ('pending', 'done', 'error', 'skipped'));

-- Der Test-Builder hat bisher die Standardwerte in die Konfiguration kopiert. Damit die neuen Standards
-- (schwerere Qualitätsfragen, abwechslungsreiche Lastprompts) greifen, werden unveränderte alte Standards entfernt.
update tests
   set configs = jsonb_set(configs, '{quality}',
         (configs -> 'quality') - 'cases'
           - case when configs -> 'quality' ->> 'minScore' = '0.8' then 'minScore' else '_' end
           - case when configs -> 'quality' ->> 'maxTokens' = '256' then 'maxTokens' else '_' end)
 where configs -> 'quality' -> 'cases' -> 0 ->> 'name' = 'Faktenwissen';
update test_definitions
   set config = config - 'cases'
         - case when config ->> 'minScore' = '0.8' then 'minScore' else '_' end
         - case when config ->> 'maxTokens' = '256' then 'maxTokens' else '_' end
 where type = 'quality' and config -> 'cases' -> 0 ->> 'name' = 'Faktenwissen';
update tests
   set configs = jsonb_set(configs, '{load}',
         (configs -> 'load') - 'prompt' - case when configs -> 'load' ->> 'maxTokens' = '64' then 'maxTokens' else '_' end)
 where configs -> 'load' ->> 'prompt' = 'Antworte mit einem kurzen Satz: Was ist ein Load Balancer?';
update test_definitions
   set config = config - 'prompt' - case when config ->> 'maxTokens' = '64' then 'maxTokens' else '_' end
 where type = 'load' and config ->> 'prompt' = 'Antworte mit einem kurzen Satz: Was ist ein Load Balancer?';
