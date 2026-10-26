# Architektur

## Überblick

```
Browser ──► Ingress ──► web (Fastify + React-SPA) ──┐
                │                                   ├──► Postgres (Daten, Sessions, Queue)
Keycloak ◄──────┘ OIDC-Login                        │
                                                    │
            worker (n Replicas) ◄── pg-boss Queue ──┘
                │
                ├──► LiteLLM-Gateway (/v1/*, /key/*, /mcp)
                ├──► vLLM-Server (/v1/*)
                └──► MCP-Server (Streamable HTTP)
```

Ein Container-Image, drei Rollen:

| Komponente | Start | Aufgabe |
|---|---|---|
| `web` | `node src/server.js` | API, Login, ausgeliefertes Frontend. Skaliert horizontal, Sessions liegen in Postgres. |
| `worker` | `node src/worker.js` | Führt Testläufe aus und startet geplante Läufe. Skaliert über Replicas und `WORKER_CONCURRENCY`. |
| `migrate` | `node src/migrate.js` | Helm-Hook-Job, wendet SQL-Migrationen an (mit Advisory Lock). |

Postgres ist die einzige Abhängigkeit: Daten, Sessions und die Job-Queue samt Cron-Schedules
([pg-boss](https://github.com/timgit/pg-boss)) liegen dort. Kein Redis, kein Message Broker.

## Login und Rollen

- Authorization Code Flow mit PKCE gegen Keycloak (`openid-client`). Session-Cookie, httpOnly.
  Keycloak liefert nur die Identität (`sub`, Name, E-Mail, `email_verified`).
- Rollen, Berechtigungen und Teams liegen in Postgres (`roles`, `user_roles`, `teams`, `team_members`)
  und werden im Admin-Bereich gepflegt. Effektive Berechtigungen = Vereinigung aller Rollen eines Users,
  bei jedem Request neu geladen (Änderungen und Sperren wirken sofort).
- `ADMIN_EMAILS`: Diese E-Mails sind immer Admin (nur bei bestätigter E-Mail), damit sich niemand
  aussperren kann. Ohne `ADMIN_EMAILS` muss mindestens ein aktiver User die Rolle Administrator behalten.
- Erster Login: bekannter `sub` → User aktualisieren; sonst vorab angelegter User mit gleicher bestätigter
  E-Mail → übernehmen; sonst neu anlegen mit der Standardrolle.
- Rechteausweitung ist ausgeschlossen: Rollen und Berechtigungen lassen sich nur vergeben, wenn man sie
  selbst hat; die Rolle Administrator vergeben nur Admins.

| Berechtigung | Erlaubt |
|---|---|
| `suite.view` | Anwendung nutzen: Dashboard, Tests, Endpoints, eigene Ergebnisse |
| `results.view_all` | globales Dashboard und Ergebnisse aller User |
| `tests.manage` | Tests und Suiten pflegen |
| `runs.start` | Läufe starten, eigene abbrechen |
| `schedules.manage` | eigene Zeitpläne pflegen |
| `runs.manage_all` | Läufe und Zeitpläne anderer User abbrechen/ändern |
| `endpoints.manage` | Endpoints und Modellkatalog |
| `users.manage` | User anlegen, sperren, Rollen und Teams zuweisen |
| `teams.manage` | Teams und Mitglieder |
| `roles.manage` | Rollen und ihre Berechtigungen |

Sichtbarkeit: eigene Läufe immer, Läufe von Mitgliedern gemeinsamer Teams immer, alle anderen nur mit
`results.view_all`. Zeitpläne laufen mit den Rechten ihres Besitzers (gesperrt oder ohne `runs.start` = kein Lauf).
- Jeder Lauf gehört dem User, der ihn gestartet hat (bzw. dem Besitzer des Zeitplans). Daraus
  entstehen die nutzerspezifischen Auswertungen und die Seite "Meine Tests".

### API-Keys

Tests laufen mit API-Keys aus einer zentralen Sammlung (`api_keys`); Endpoints und Tests verweisen nur
darauf. Ein Key ist `user` (nur der Ersteller), `teams` (Mitglieder der Teams) oder `global`
(Administratoren), zusätzlich lassen sich Keys einzelnen Usern zuordnen oder auf `admin_only` stellen.
Normale User legen nur Keys für sich und ihre Teams an. Auflösung im Executor: Key des Laufs, dann Key
des Tests, dann Key des Endpoints. In `access`- und `mcp`-Fällen wählt `apiKey` einen Key per Namen.

LLM-Endpoints gibt es als OpenAI-compatible oder Claude (Anthropic Messages API, Übersetzung im Client).
vLLM-Endpunkte brauchen keine Berechtigung; dort bleibt der API-Key leer.

Secrets (API-Keys) werden mit AES-256-GCM verschlüsselt gespeichert,
der Schlüssel wird aus `APP_SECRET` abgeleitet.

## Modellkatalog

LiteLLM und vLLM benennen dasselbe Modell unterschiedlich (z. B. `qwen3-32b` im Gateway,
`Qwen/Qwen3-32B` am vLLM-Endpunkt), und es gibt einen vLLM-Endpunkt pro Modell. Deshalb:

- Jeder Endpoint wird über `/v1/models` abgefragt: beim Anlegen/Speichern, beim Verbindungstest,
  per Button und alle 15 Minuten im Worker (`MODEL_SYNC_CRON`). Ergebnis ist die Tabelle
  `endpoint_models`. Nicht mehr gelistete Modelle bleiben mit `available = false` erhalten.
- Im Admin-Bereich "Modellkatalog" bekommt jedes Modell manuell einen **Alias**. Gleicher Alias =
  gleiches Modell, egal über welchen Endpoint.
- Tests dürfen Alias oder echten Namen angeben; der Runner setzt pro Endpoint den richtigen Namen
  ein. Ergebnisse speichern beides (`model`, `model_alias`), das Dashboard gruppiert nach Alias.
- Für Endpoints ohne `/v1/models` können Modelle manuell eingetragen werden.

## Testtypen

Jeder Typ ist ein Modul in `server/src/testtypes/` mit `{ type, label, description, defaults, run(ctx) }`.
Neue Typen werden in `testtypes/index.js` registriert und erscheinen automatisch in der UI.

| Typ | Prüft | Typische Kennzahlen |
|---|---|---|
| `smoke` | Erreichbarkeit, `/v1/models`, Mini-Request je Modell | gesunde Modelle |
| `performance` | Streaming mit fester Parallelität | TTFT p50/p95, Latenz p95, Tokens/s, Fehlerquote |
| `load` | Stufen mit steigender Parallelität (Ramp-up); jede Anfrage zieht einen anderen Prompt aus einem Pool (leicht/mittel/schwer, Mischung `mix`) mit Zufallspräfix gegen Prefix-Caches | req/s, Tokens/s, Fehlerquote, p95 je Stufe und Schwierigkeit, gedrosselte Anfragen (429) |
| `quality` | fünf Fragen von leicht bis extrem schwer (Logik, Textaufgabe, Code lesen, Wahrscheinlichkeit, Kombinatorik); Schlusszeile „Antwort: …“; Score nach Stufe gewichtet. Eigene Datensätze mit Regeln: contains, regex, JSON, Länge, PII, LLM-as-a-Judge | Score, höchste gelöste Stufe |
| `coding` | zwei JavaScript-Aufgaben (einfach, komplex); der Code läuft in einem isolierten Kindprozess (`sandbox-runner.mjs`, Node-Berechtigungsmodell ohne Dateisystem/Kindprozesse, leerer vm-Kontext, leere Umgebung) gegen vorbereitete Tests | Score (komplexe Aufgabe zählt doppelt), Tests je Aufgabe |
| `ocr` | zwei Dokumente als Bild (`server/fixtures/ocr`, erzeugt mit `tools/generate-ocr-docs.py`): Rechnung (Positionen aggregieren) und Prüfbericht mit Handschrift und zwei Unterschriften; Vision-Modell nötig | Score = Anteil richtig gelesener Felder |
| `thinking` | dieselben Aufgaben mit und ohne Reasoning (Varianten frei konfigurierbar) | Genauigkeit, Ø Tokens und Reasoning-Tokens, Latenz, Tokens je richtige Antwort, Schlüssigkeit per Judge, Genauigkeitsgewinn pro 1.000 Zusatz-Tokens |
| `security` | Prompt Injection, Jailbreak, schädliche Anfragen, DLP auf Ein- und Ausgabe | Pass-Rate je Kategorie, vom Gateway geblockt |
| `access` | API-Key X darf Modell/Route Y (nicht) nutzen | falsch erlaubt, falsch verweigert |
| `mcp` | Tool-Katalog je API-Key, Tool-Aufrufe, verbotene Tools | geleakte Tools, Checks |
| `structured` | Function Calling und JSON-Ausgaben | korrekt aufgerufene Tools |

**Regression** ist kein eigener Typ, sondern läuft bei jedem Ergebnis mit: Kennzahlen werden mit der
letzten bestandenen Ausführung derselben Testdefinition verglichen (Standardtoleranz 20 %,
`regressionTolerance`). Mit `failOnRegression: true` schlägt der Test dann fehl.

## Ausführung

- **Einzeln**, **Auswahl**, **Suite** (gebündelter Lauf) oder **alle aktiven Tests**: `POST /api/runs`
  legt einen Lauf an und stellt ihn in die Queue.
- **Zeitpläne**: Cron-Ausdruck mit Zeitzone, Ziel ist ein Test, eine Suite oder alle Tests. Die
  Schedules werden in pg-boss gespiegelt; genau ein Worker erzeugt pro Termin den Lauf.
- Tests eines Laufs laufen nacheinander, Läufe parallel (pro Worker `WORKER_CONCURRENCY`).
- **Alle Tests, auch Lasttests, laufen in den Pods der Anwendung** (Worker-Deployment bzw. lokal im
  Web-Prozess). Die Anwendung erzeugt keine Pods oder Jobs und braucht keine Kubernetes-API-Rechte.
  Mehr Last = mehr Worker-Replicas oder höhere Ressourcen-Limits.
- Abbruch über die UI; der Worker prüft zwischen den Tests. Timeout pro Test über `timeoutS`.

## Datenmodell

| Tabelle | Inhalt |
|---|---|
| `users` | aus Keycloak übernommen (sub, Name, E-Mail, letzter Login), gesperrt ja/nein; vorab angelegte User ohne sub |
| `roles`, `user_roles` | Rollen mit Berechtigungen, Zuordnung zu Usern |
| `teams`, `team_members` | Teams und Mitglieder |
| `endpoints` | LiteLLM/vLLM/MCP mit URL, optional verschlüsseltem Key, Discovery-Status |
| `endpoint_models` | abgefragte Modelle je Endpoint mit Alias und Verfügbarkeit |
| `api_keys` | API-Key-Sammlung (verschlüsselt) mit Teams/Usern |
| `tests`, `test_teams` | Test aus dem Test-Builder: Name, Beschreibung, Tags, Maintainer, Endpoint, Modelle, API-Key, Testarten mit Konfiguration, Veröffentlichung |
| `test_watchlist` | Merkliste je User |
| `test_definitions` | ausführbare Einzeltests (Testart × Modell), vom Test erzeugt (`build_id`) und bei jedem Speichern abgeglichen, damit IDs und Historie stabil bleiben |
| `suites`, `suite_tests` | Altbestand, wird von der UI nicht mehr verwendet |
| `schedules` | Cron oder einmaliger Zeitpunkt (`run_at`), Ziel (Test), Besitzer |
| `runs` | ein Lauf: Art, Auslöser, User, Status, Zähler |
| `results` | ein Ergebnis pro Test und Lauf: Status, Score, Kennzahlen, Details. Name, Typ, Endpoint und Modell sind denormalisiert, damit die Historie stabil bleibt. |
| `run_logs` | Logzeilen pro Lauf bzw. Ergebnis |
| `app_settings` | Einstellungen der Anwendung, z. B. `analysis_model` (Endpoint und Modell für die KI-Analyse) |

## KI-Analyse

Nach jedem Lauf erzeugt das im Modellkatalog festgelegte Modell (`app_settings.analysis_model`, Endpoint-eigener
Key) eine Analyse: Bewertung, Einordnung der Ergebnisse (Schwellen, Baseline, Schwierigkeitsstufen) und
Empfehlungen. Der Worker schickt dafür eine verkürzte Fassung der Ergebnisse (`analysisBrief.js`) und speichert
den Text in `runs.analysis` (`analysis_status`: pending, done, error, skipped). Ein Fehler dabei lässt den Lauf
nie scheitern; `POST /api/runs/:id/analysis` erzeugt die Analyse neu.

## Plattform

Die Seite „Plattform“ (`web/src/pages/Platform.jsx`) beschreibt den Cluster: GPU-Typ und -Anzahl, NVLink, Inferenzserver
(Tensor-Parallelität, `max_num_seqs`) und AI-Gateway. Die Konfiguration liegt in `platform_config` (eine Zeile, nur
Administratoren ändern sie, alle mit `suite.view` lesen).

**Rechenmodell** (`web/src/platformModel.js`, alles Schätzungen): VRAM und Bandbreite sind Summen der Datenblattwerte;
ein Modell passt, wenn Gewichte plus KV-Cache in den nutzbaren Speicher (`gpu_memory_utilization`) passen. Die
Token-Rate je Anfrage ergibt sich aus dem Roofline-Ansatz (Zeit für Gewichte lesen gegen Rechenzeit, bei MoE nur die
berührten Experten), mit einem Abschlag für Tensor-Parallelität (kleiner ohne NVLink). Gleichzeitige Anfragen sind durch
KV-Cache und `max_num_seqs` begrenzt; Nutzer ergeben sich aus Ziel-Tempo, Antwortlänge und Pause zwischen Anfragen.
Eigene Modelldaten (JSON) werden lokal im Browser gehalten.

**Messung**: Je Komponente lassen sich Prometheus-Endpunkte hinterlegen (`platformMetrics.js`, DCGM-Namen laut
NVIDIA-Doku, vLLM, LiteLLM). Die Seite zeigt Live-Werte (`/api/platform/live`, 5 s Cache). Der Lasttest fragt sie alle
5 s ab und speichert Spitzen und Mittel in `results.details.platform`; `/api/platform/load-results` vergleicht sie mit
der Schätzung. Metriknamen können je Version abweichen, fehlende Werte werden ausgeblendet.

## Test-Builder

Ein Test (`tests`) bündelt beliebig viele Testarten für einen Endpoint. Beim Speichern erzeugt
`syncAtoms` je Testart und Modell einen Einzeltest (`test_definitions`), abhängig vom `modelMode` der
Testart: `each` (ein Test je Modell, z. B. Performance), `list` (Modellliste in der Konfiguration, z. B.
Smoke), `first` (erstes Modell, z. B. Zugriff) oder `none` (MCP). Ein Lauf vom Typ `build`
führt alle Einzeltests des Tests aus. Zeitpläne eines Tests sind Cron-Ausdrücke oder ein einmaliger
Zeitpunkt (pg-boss `startAfter`); die Zusammenfassung im Editor nennt nur Anzahl und geschätzte Laufzeit
(Median früherer Ausführungen der Testart, sonst Richtwerte; `POST /api/builds/preview`); `/api/calendar` liefert daraus die kommenden Termine und die bisherigen
Läufe. Sichtbar ist ein Test für Ersteller, Maintainer und Administratoren, nach dem Veröffentlichen
zusätzlich für die gewählten Teams oder alle. Im Marketplace führen andere User veröffentlichte Tests aus;
ist `requires_api_key` gesetzt, wählen sie einen eigenen Key (`runs.api_key_id`), der vor dem Key des Tests
und des Endpoints gilt.

## Kubernetes

Helm-Chart unter `deploy/helm/ai-testing-suite`:

| Ressource | Hinweis |
|---|---|
| Deployment `web` + Service | API und Frontend; mit `worker.embedded=true` laufen hier auch die Tests |
| Deployment `worker` | entfällt bei `worker.embedded=true` |
| Ingress | `className`, Annotationen, TLS-Secret konfigurierbar |
| Job `migrate` | Helm-Hook; mit interner Postgres nach der Installation, sonst davor |
| Secret | Hook vor Installation/Upgrade; `APP_SECRET` und Postgres-Passwort werden erzeugt und per `lookup` bei Upgrades übernommen. Oder `existingSecret`. |
| StatefulSet + Service `postgres` | Single-Instance, standardmäßig aktiv |
| PVC `postgres-data` | eigenes PVC mit `helm.sh/resource-policy: keep`, alternativ `existingClaim` oder `emptyDir` |

Die eingebaute Postgres hat kein Backup und keine HA. Für Produktion eine verwaltete Postgres oder
CloudNativePG nutzen (`postgresql.enabled=false`, `secrets.databaseUrl`).

Der Worker braucht Netzwerkzugriff auf die getesteten Endpoints. Läuft vLLM im selben Cluster,
genügt die Service-URL (`http://vllm.<ns>.svc.cluster.local:8000`).

## Ausbaustufen

- Lasttests über mehrere Worker-Pods verteilen (ein Lauf, mehrere Lastgeneratoren über die Queue).
- Weitere Testtypen: Fallback/Routing in LiteLLM, Long-Context, Kosten-/Spend-Tracking,
  Prompt-Caching, Embeddings/Reranker.
- Export der Kennzahlen nach Prometheus und Benachrichtigung bei Fehlschlägen (Teams/Slack/E-Mail).
- Testdatensätze als eigene, versionierte Objekte statt in der Testkonfiguration.
