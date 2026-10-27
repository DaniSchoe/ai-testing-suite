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
| `suite.view` | Anwendung nutzen: Dashboard, Läufe, Findings, freigegebene Berichte |
| `results.view_all` | Läufe und Ergebnisse aller Personen des Mandanten |
| `tests.manage` | Datensätze, Vorlagen und Prüfungen pflegen |
| `runs.start` | Läufe und Testläufe starten, eigene abbrechen |
| `schedules.manage` | eigene Zeitpläne pflegen |
| `runs.manage_all` | Läufe und Zeitpläne anderer abbrechen/ändern |
| `endpoints.manage` | Plattformen und Komponenten, Modellkatalog, Sizing, KI-Analyse-Modell |
| `users.manage`, `teams.manage` | Mitglieder, Rollenvergabe (nur eigene Rechte), Teams, Service-Tokens |
| `catalog.publish` | Vorlagen im Review prüfen und veröffentlichen |
| `security.payloads` | Angriffs-Datensätze, Prompts und Antworten aus Security-Tests sehen; zweite Freigabestufe für Security-Vorlagen |
| `runs.prod` | Prod-Läufe und Lasttests freigeben, Plattform sperren (Kill-Switch) |
| `reports.approve` | Prüfberichte freigeben, KI-Entwurf übernehmen |
| `findings.manage` | Findings bearbeiten, zuweisen, Nachtest |
| `roles.manage`, `tenants.manage`, `settings.manage`, `audit.view` | systemweit (nur Systemadministration) |

Mitgelieferte Rollen: Administrator, Engagement Lead, Test Engineer, Red Teamer, Reviewer, Kunden-Viewer, Service Account.
Rollen sind global definiert und werden je Mandant (`user_roles.tenant_id`) vergeben; Systemrechte gelten nur in Rollen
ohne Mandantenbezug.

Sichtbarkeit: Mit `results.view_all` sieht man alle Läufe des Mandanten, sonst eigene und die gemeinsamer Teams.
Zeitpläne laufen mit den Rechten ihres Besitzers (gesperrt oder ohne `runs.start` = kein Lauf).

### Mandanten

Jede Anfrage gehört zu einem Mandanten (`X-Tenant-Id`, sonst der erste des Users; `user.tenant_id`). Plattformen, Komponenten,
Datensätze und Vorlagen (eigene), Prüfungen, Zugangsdaten, Läufe, Findings, Berichte, Freigaben und Zeitpläne tragen `tenant_id`;
alle Abfragen filtern darauf. Offizielle Vorlagen, Datensätze und Kategorien haben `tenant_id is null` und sind für alle
lesbar, aber schreibgeschützt. Die Umgebung (Dev/Prod/alle) ist eine Ansicht der Oberfläche (`?environment=`), keine Berechtigung.

### API-Keys

Prüfungen laufen mit API-Keys aus einer zentralen Sammlung (`api_keys`); Komponenten und Prüfungen verweisen nur
darauf. Ein Key ist `user` (nur der Ersteller), `teams` (Mitglieder der Teams) oder `global`
(Administratoren), zusätzlich lassen sich Keys einzelnen Usern zuordnen oder auf `admin_only` stellen.
Normale User legen nur Keys für sich und ihre Teams an. Auflösung im Executor: Key des Laufs, dann Key
der Prüfung, dann Key des Endpoints. In `access`- und `mcp`-Fällen wählt `apiKey` einen Key per Namen.

LLM-Endpoints gibt es als OpenAI-compatible oder Claude (Anthropic Messages API, Übersetzung im Client).
vLLM-Endpunkte brauchen keine Berechtigung; dort bleibt der API-Key leer.

Secrets (API-Keys) werden mit AES-256-GCM verschlüsselt gespeichert,
der Schlüssel wird aus `APP_SECRET` abgeleitet.

## Modellportfolio

LiteLLM und vLLM benennen dasselbe Modell unterschiedlich (z. B. `qwen3-32b` im Gateway,
`Qwen/Qwen3-32B` am vLLM-Endpunkt), und es gibt einen vLLM-Endpunkt pro Modell. Deshalb:

- Jeder Endpoint wird über `/v1/models` abgefragt: beim Anlegen/Speichern, beim Verbindungstest,
  per Button und alle 15 Minuten im Worker (`MODEL_SYNC_CRON`). Ergebnis ist die Tabelle
  `endpoint_models`. Nicht mehr gelistete Modelle bleiben mit `available = false` erhalten.
- Im "Modellkatalog" bekommt jedes Modell manuell einen **Alias** sowie Metadaten (Lizenz, Anbieter, Herkunft, Open Weights, Revision, Quantisierung, Kontextlänge, Fähigkeiten wie Vision oder Tool-Calling). Gleicher Alias =
  gleiches Modell, egal über welchen Endpoint.
- Prüfungen dürfen Alias oder echten Namen angeben; der Runner setzt pro Endpoint den richtigen Namen
  ein. Ergebnisse speichern beides (`model`, `model_alias`), das Dashboard gruppiert nach Alias.
- Für Endpoints ohne `/v1/models` können Modelle manuell eingetragen werden.

## Testarten, Vorlagen und Datensätze

Jede Testart ist ein Modul in `server/src/testtypes/` mit `{ type, label, run(ctx) }` und in `testtypes/index.js` registriert.
Was geprüft wird, beschreibt eine **Vorlage** (`templates`, `template_versions`): Testart, Datensatz in fester Version, Voraussetzungen
(`requires`: vision, tools, reasoning, mcp, json), Bewertung (`scoring`), vorgeschlagene Schwellwerte und Einsatzprofile (chat, coding, ocr, agent).

| Testart | Prüft | Typische Kennzahlen |
|---|---|---|
| `smoke` | Erreichbarkeit, `/v1/models`, Mini-Request je Modell | gesunde Modelle |
| `performance` | Streaming mit fester Parallelität | TTFT p50/p95, Latenz p95, Tokens/s, Fehlerquote |
| `load` | Stufen mit steigender Parallelität; jede Anfrage zieht einen anderen Prompt (leicht/mittel/schwer) mit Zufallspräfix gegen Prefix-Caches | req/s, Fehlerquote, p95 je Stufe, 429 |
| `quality` | Fragen von leicht bis extrem schwer; Schlusszeile „Antwort: …“; Regeln: contains, regex, JSON, Länge, PII, LLM-as-a-Judge | Score, höchste gelöste Stufe |
| `coding` | JavaScript-Aufgaben, Code läuft isoliert (`sandbox-runner.mjs`, Node-Berechtigungsmodell, leerer vm-Kontext) gegen Tests | Score |
| `ocr` | Dokumente als Bild, Ground Truth mit typisierten Feldern (Zahl mit Toleranz, Datum, IBAN, Wahrheitswert, Stichwörter, exakt) und Feldgewichten; Vision nötig | Score je Feld |
| `thinking` | dieselben Aufgaben mit und ohne Reasoning | Genauigkeit, Tokens, Latenz, Schlüssigkeit |
| `security` | Prompt Injection, Jailbreak, schädliche Anfragen, DLP | Pass-Rate je Kategorie, vom Gateway geblockt |
| `access` | API-Key X darf Modell/Route Y (nicht) nutzen | falsch erlaubt, falsch verweigert |
| `mcp` | Tool-Katalog je API-Key, Tool-Aufrufe, verbotene Tools | geleakte Tools |
| `structured` | Function Calling und JSON-Ausgaben | korrekt aufgerufene Tools |

**Datensätze** (`datasets`, `dataset_versions`, `dataset_cases`, `dataset_files`) sind eigene versionierte Objekte (SemVer, Hash über
Fälle und Dateien) mit Art, Sprache, Sensitivität (public, internal, customer, attack) und Mindestzahl Fälle. CSV, JSONL und JSON werden gegen
ein Schema je Art geprüft (Trockenlauf `POST /api/datasets/validate`). Unter der Mindestzahl gilt das Ergebnis als „kleine Stichprobe“.
Angriffs-Datensätze sind ohne `security.payloads` maskiert. Die Standardinhalte (Qualität, Coding, OCR, Security …) kommen als offizielle Datensätze mit dem Release.

**Katalog-Lebenszyklus**: Entwurf → Prüfung → Veröffentlicht → Veraltet. Freigabe braucht `catalog.publish` und eine andere Person als die
einreichende; Security-Vorlagen durchlaufen eine zweite Stufe (`security.payloads`, wieder eine andere Person). Veröffentlichte Versionen sind
unveränderlich; Änderungen sind eine neue Version. Prüfungen übernehmen neuere Versionen nur ausdrücklich. Offizielle Inhalte liegen im Code
(`catalogSync.js`) und werden beim Start per Hash abgeglichen. Export/Import als YAML oder JSON im Schema `ai-testing-suite/v1` (optional mit
Datensätzen); Importiertes ist ein privater Entwurf. Kategorien (AIC4, OWASP LLM Top 10, SOV) hängen an Vorlagenversionen.

## Prüfungen und Ausführung

Eine **Prüfung** (`audits`) hat ein Ziel (Plattform), Positionen (Vorlagenversion mit Schwellwerten), Modelle mit Pfad (direkt, Gateway, beide),
Wiederholungen, Regressionstoleranz, Baseline, Gate und optional einen Zeitplan. `plan.js` macht daraus **Atome** (`runs.plan`): Modus „each“
(Modell × Pfad), „list“ (Smoke je Endpoint), „first“ (Zugriff über das Gateway), MCP je Endpoint; im Vergleichsmodus zwei Varianten A/B.
Fehlen Voraussetzungen oder Endpoint, ist das Atom nicht anwendbar (Ergebnis `skipped`, Klasse `not_applicable`).

- Läufe starten über `POST /api/audits/:id/run` (UI, Service-Token oder Zeitplan); Testläufe aus dem Katalog sind Entwürfe (`runs.is_draft`).
- Der Worker lädt die Datensatzversion, führt jedes Atom (bei Wiederholungen mehrfach, Median plus Streuung) aus und wertet die Schwellwerte aus
  (`evaluate.js`). Zugriffstests mit falsch erlaubtem Zugriff sind immer fehlgeschlagen.
- **Ergebnisklassen**: bestanden, Qualitätsabweichung, Sicherheitsbefund (security/access/mcp), technischer Fehler, nicht anwendbar.
- **Baseline**: ausdrücklich gesetzter Referenzlauf (oder der erste, wenn `baseline_auto`); Verschlechterungen über der Toleranz sind Regressionen.
- Zu Beginn wird ein **Snapshot** der Plattform gespeichert (Komponentenversionen, Modelle, Routen) samt Änderungen seit dem letzten Lauf.
- **Alle Tests, auch Lasttests, laufen in den Pods der Anwendung**. Die Anwendung erzeugt keine Pods und braucht keine Kubernetes-API-Rechte.
- Zeitpläne (Cron oder einmalig) werden in pg-boss gespiegelt; ein Worker erzeugt pro Termin den Lauf mit den Rechten des Besitzers. Kann er nicht
  starten (Freigabe fehlt, Plattform gesperrt), steht `schedule.skipped` im Audit-Log.

**Freigaben**: Läufe gegen Prod-Plattformen und Lasttests brauchen eine gültige Freigabe (`approvals`): beantragt von der einen, entschieden von einer
anderen Person mit `runs.prod`; mit Zeitfenster, erlaubter Laufzahl und Lastgrenzen (wirksam ist das Minimum aus Prüfung und Freigabe). Fehlt sie,
antwortet der Start mit 409. **Kill-Switch**: Eine gesperrte Plattform (`platforms.locked`) startet nichts (423) und bricht laufende Läufe ab.

**CI/CD**: `GET /api/runs/:id/gate` liefert bestanden/nicht bestanden gemäß dem Gate der Prüfung; `server/tools/cli.js` kapselt Start, Warten und
Exit-Code. Service-Tokens (`sat_…`) sind je Mandant, nur Hash gespeichert, widerrufbar.

## Nachweise, Findings und Berichte

- **Nachweise** (`evidence`): Prompt, Antwort und Bewertung je Fall mit SHA-256; die Hashes eines Laufs bilden eine Kette (`runs.evidence_hash`),
  `GET /api/runs/:id/evidence/verify` prüft sie. Aufbewahrung nach Sensitivität (Standard 365/180/90/30 Tage, einstellbar); danach werden Prompt und
  Antwort gelöscht, Hash und Ergebnis bleiben. Angriffsinhalte sind ohne `security.payloads` maskiert.
- **Findings** (`findings`): entstehen aus Sicherheitsbefunden, dedupliziert über einen Fingerprint (Vorlage, Modell, Pfad, Fall); Schwere, Zuordnung zu OWASP
  LLM Top 10, Status (offen, in Bearbeitung, behoben, akzeptiert, Fehlalarm), Verantwortlicher, Verlauf. Ein **Nachtest** führt nur die betroffene Vorlage mit Modell und Pfad erneut aus
  und setzt das Ergebnis am Finding.
- **Berichte** (`reports`): entstehen aus dem Lauf (Gesamturteil, Ergebnisse je Vorlage mit Konfidenz, Findings, Zuordnung zu Rahmenwerken, Snapshot, Nachweishash).
  Die Zusammenfassung ist redigierbar (Standardtext aus den Daten); der KI-Entwurf wird nur von einem Reviewer übernommen. Ablauf Entwurf → Prüfung → Freigegeben
  mit anderer Person; Export als Markdown/HTML. Kunden-Viewer sehen nur freigegebene Berichte.

## Dashboard

Die gewählte Plattform (Auswahl oben rechts) und darunter das Modell (`dashboard.js`, `/api/dashboard/*`). Kacheln führen zu Findings, Berichten und Souveränität. Es zählen nur Läufe von Prüfungen, keine Testläufe.
Die **Scorecard** hat fünf Dimensionen (Qualität, Sicherheit, Performance, Effizienz, Souveränität) mit dokumentierter Normalisierung
(`/api/dashboard/normalization`, Version 1): Fallzahlen werden gepoolt und mit Wilson-Intervall ausgewiesen, Perzentile über Rohproben
(nie Mittel von Perzentilen), „geringe Aussagekraft“ bei kleinen Stichproben. **Eignungsprofile** (Chat, Coding, OCR, Agent) gewichten die
Dimensionen; unter 60 % Abdeckung heißt das Ergebnis „zu wenig Daten“. Die OWASP-Heatmap trennt Blockaden durch das Gateway von Verweigerungen des Modells.
**Souveränität und Einstufung** (`assessment.js`, `/api/platforms/:id/assessment`): Die Einstufung entsteht aus Inventar, Topologie, Modellportfolio, Betriebszustand und neuesten Tests, nicht mehr aus Erklärungen. Jeder Bereich (Sicherheit, Produktionsreife, SOV-1 bis SOV-8) besteht aus Prüfpunkten mit Status (erfüllt, teilweise, nicht erfüllt, unbekannt), Gewicht und Begründung. Punktzahl = gewichteter Anteil (erfüllt 1, teilweise 0,5; unbekannte Punkte zählen nicht), bei unter 40 % Abdeckung gibt es keine Einstufung. SEAL je Ziel aus der Punktzahl (≥95 % → 4, ≥80 % → 3, ≥60 % → 2, ≥30 % → 1); ein nicht erfülltes Prüfkriterium mit Gewicht ≥ 3 begrenzt das Ziel auf SEAL-2. Ein Ziel lässt sich mit Begründung überschreiben (Person und Zeitpunkt werden festgehalten); die Überschreibung ersetzt die abgeleitete Stufe.
Die Kundenansicht blendet Rohdaten und Fehlermeldungen aus.

## Datenmodell

| Tabelle | Inhalt |
|---|---|
| `tenants` | Mandanten |
| `users`, `roles`, `user_roles` | Personen (aus Keycloak), Rollen mit Berechtigungen, Zuordnung je Mandant |
| `teams`, `team_members` | Teams und Mitglieder |
| `service_tokens` | Tokens für CI/CD (Hash, Präfix, Ablauf, Widerruf) |
| `platforms`, `platform_routes` | Ziele (Umgebung, Sperre, Mindeststufe und Überschreibungen der Souveränität, Layout der Topologie) und Routen Gateway → Inferenzserver |
| `endpoints`, `endpoint_models` | Komponenten einer Plattform (AI Proxy, LLM, MCP) und abgefragte Modelle mit Alias und Metadaten |
| `api_keys` | API-Key-Sammlung (verschlüsselt) mit Teams/Usern |
| `datasets`, `dataset_versions`, `dataset_cases`, `dataset_files` | versionierte Datensätze |
| `templates`, `template_versions`, `categories`, `template_version_categories` | Vorlagen mit Versionen und Rahmenwerks-Kategorien |
| `platform_links` | Zuordnungen im Inventar: `hosted_in` (GPU/Kubernetes → Rechenzentrum), `cluster` (GPU → Kubernetes), `runs_on` (Inferenzserver → GPU, `data.mig_slice` für MIG) |
| `portfolio_models`, `portfolio_model_teams` | Modellportfolio; `endpoint_models.portfolio_id` ordnet gefundene Modelle zu |
| `audits`, `audit_teams` | Prüfungen |
| `schedules` | Cron oder einmaliger Zeitpunkt je Prüfung |
| `approvals` | Anträge und Freigaben für Prod und Last |
| `runs` | ein Lauf: Plan, Status, Ergebnisklassen, Snapshot, Vergleich, Nachweiskette, Entwurf |
| `results` | ein Ergebnis je Atom: Status, Ergebnisklasse, Score, Kennzahlen, Statistik, Details; Vorlage, Version, Modell, Pfad denormalisiert |
| `evidence` | Nachweise mit Hash und Aufbewahrungsfrist |
| `findings`, `finding_events` | Befunde mit Verlauf |
| `reports` | Prüfberichte |
| `run_logs` | Logzeilen je Lauf bzw. Ergebnis |
| `audit_log` | Protokoll sicherheitsrelevanter Aktionen |
| `app_settings` | Einstellungen, z. B. `analysis_model:<mandant>` und `retention` |

## KI-Analyse

Nach jedem Lauf erzeugt das im Modellkatalog festgelegte Modell (`app_settings.analysis_model`, Endpoint-eigener
Key) eine Analyse: Bewertung, Einordnung der Ergebnisse (Schwellen, Baseline, Schwierigkeitsstufen) und
Empfehlungen. Der Worker schickt dafür eine verkürzte Fassung der Ergebnisse (`analysisBrief.js`) und speichert
den Text in `runs.analysis` (`analysis_status`: pending, done, error, skipped). Ein Fehler dabei lässt den Lauf
nie scheitern; `POST /api/runs/:id/analysis` erzeugt die Analyse neu.

## Inventar und Topologie

Die Komponenten einer Plattform bilden ein Inventar (`endpoints`, Spalte `spec` je Art, `inventory.js`/`inventorySpec.js`): Rechenzentrum (Anbieter, On-Prem, Region, Zertifikate wie NIST oder C5), Kubernetes (selbst betrieben oder managed, Distribution), GPU-Server (H100, H200, RTX PRO 6000, B100, B200, B300 oder eigener Typ; jede GPU ein Eintrag, optional MIG-Layout und DCGM-Endpunkt), Inferenzserver (selbst betrieben oder Managed Service wie ChatGPT oder Claude), AI Gateway sowie MCP, Vektor-DB, IAM und Observability. Die Topologie (`PUT /api/platforms/:id/topology`) legt per Drag & Drop fest, wo Komponenten stehen, auf welcher GPU bzw. MIG-Instanz ein Inferenzserver läuft, welche Modelle er bereitstellt und welche Modelle das Gateway an ihn routet.

## Plattform

Die Seite „Sizing“ (`web/src/pages/SizingView.jsx`, je Plattform) beschreibt den Cluster: GPU-Typ und -Anzahl, NVLink, Inferenzserver
(Tensor-Parallelität, `max_num_seqs`) und AI-Gateway. Die Konfiguration liegt je Plattform in `platform_config` (`/api/platforms/:id/sizing`; nur `endpoints.manage` ändert sie, alle mit `suite.view` lesen).

**Rechenmodell** (`web/src/platformModel.js`, alles Schätzungen): VRAM und Bandbreite sind Summen der Datenblattwerte;
ein Modell passt, wenn Gewichte plus KV-Cache in den nutzbaren Speicher (`gpu_memory_utilization`) passen. Die
Token-Rate je Anfrage ergibt sich aus dem Roofline-Ansatz (Zeit für Gewichte lesen gegen Rechenzeit, bei MoE nur die
berührten Experten), mit einem Abschlag für Tensor-Parallelität (kleiner ohne NVLink). Gleichzeitige Anfragen sind durch
KV-Cache und `max_num_seqs` begrenzt; Nutzer ergeben sich aus Ziel-Tempo, Antwortlänge und Pause zwischen Anfragen.
Eigene Modelldaten (JSON) werden lokal im Browser gehalten.

**Messung**: Je Komponente lassen sich Prometheus-Endpunkte hinterlegen (`platformMetrics.js`, DCGM-Namen laut
NVIDIA-Doku, vLLM, LiteLLM). Die Seite zeigt Live-Werte (`/api/platforms/:id/sizing/live`, 5 s Cache). Der Lasttest fragt sie alle
5 s ab und speichert Spitzen und Mittel in `results.details.platform`; `/api/platforms/:id/sizing/load-results` vergleicht sie mit
der Schätzung. Metriknamen können je Version abweichen, fehlende Werte werden ausgeblendet.

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
- Weitere Testarten: Fallback/Routing in LiteLLM, Long-Context, Kosten-/Spend-Tracking, Prompt-Caching, Embeddings/Reranker.
- Export der Kennzahlen nach Prometheus und Benachrichtigung bei Fehlschlägen (Teams/Slack/E-Mail).
- Signierte Berichte und Nachweise (Zeitstempel durch Dritte).
