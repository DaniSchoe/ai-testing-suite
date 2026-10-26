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
- Rollen aus `realm_access.roles` bzw. Client-Rollen werden abgebildet auf:
  - `admin` (`suite-admin`): Endpoints, Personas, Benutzerübersicht
  - `tester` (`suite-tester`): Tests, Suiten, Zeitpläne anlegen und ausführen
  - `viewer` (`suite-viewer`): Dashboard und Ergebnisse ansehen
- Jeder Lauf gehört dem User, der ihn gestartet hat (bzw. dem Besitzer des Zeitplans). Daraus
  entstehen die nutzerspezifischen Auswertungen und die Seite "Meine Tests".

### Test-Personas

Personas sind die Identitäten, *unter denen* Tests laufen, getrennt vom angemeldeten User:

- `keycloak_password`: Keycloak-Testuser. Der Runner holt sich per Password Grant über einen
  eigenen Client (`ai-testing-personas`) ein Access Token und schickt es als Bearer-Token an
  LiteLLM bzw. den MCP-Server. Damit lassen sich userspezifische Freigaben (Modelle, MCP-Tools)
  testen, wenn LiteLLM JWT-Auth nutzt.
- `api_key`: z. B. LiteLLM Virtual Keys pro Team.
- `none`: anonym, für Negativtests.

Secrets (Endpoint-Keys, Persona-Passwörter) werden mit AES-256-GCM verschlüsselt gespeichert,
der Schlüssel wird aus `APP_SECRET` abgeleitet.

## Testtypen

Jeder Typ ist ein Modul in `server/src/testtypes/` mit `{ type, label, description, defaults, run(ctx) }`.
Neue Typen werden in `testtypes/index.js` registriert und erscheinen automatisch in der UI.

| Typ | Prüft | Typische Kennzahlen |
|---|---|---|
| `smoke` | Erreichbarkeit, `/v1/models`, Mini-Request je Modell | gesunde Modelle |
| `performance` | Streaming mit fester Parallelität | TTFT p50/p95, Latenz p95, Tokens/s, Fehlerquote |
| `load` | Stufen mit steigender Parallelität (Ramp-up) | req/s, Tokens/s, Fehlerquote und p95 je Stufe |
| `quality` | Datensatz mit Regeln: contains, regex, JSON, Länge, PII, LLM-as-a-Judge | Score (Anteil bestandener Fälle) |
| `comparison` | gleicher Datensatz gegen mehrere Modelle | Ranking nach Score und Latenz |
| `security` | Prompt Injection, Jailbreak, schädliche Anfragen, DLP auf Ein- und Ausgabe | Pass-Rate je Kategorie, vom Gateway geblockt |
| `access` | Persona X darf Modell/Route Y (nicht) nutzen | falsch erlaubt, falsch verweigert |
| `mcp` | Tool-Katalog je Persona, Tool-Aufrufe, verbotene Tools | geleakte Tools, Checks |
| `ratelimit` | Burst gegen RPM/TPM-Limits (Virtual Keys, Teams) | erfolgreich vs. 429 |
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
- Abbruch über die UI; der Worker prüft zwischen den Tests. Timeout pro Test über `timeoutS`.

## Datenmodell

| Tabelle | Inhalt |
|---|---|
| `users` | aus Keycloak übernommen (sub, Name, Rollen, letzter Login) |
| `endpoints` | LiteLLM/vLLM/MCP mit URL, verschlüsseltem Key, Modellen |
| `personas` | Test-Identitäten mit verschlüsseltem Secret |
| `test_definitions` | Typ, Endpoint, Persona, Konfiguration (JSON) |
| `suites`, `suite_tests` | gebündelte Läufe mit Reihenfolge |
| `schedules` | Cron, Ziel, Besitzer |
| `runs` | ein Lauf: Art, Auslöser, User, Status, Zähler |
| `results` | ein Ergebnis pro Test und Lauf: Status, Score, Kennzahlen, Details. Name, Typ, Endpoint und Modell sind denormalisiert, damit die Historie stabil bleibt. |
| `run_logs` | Logzeilen pro Lauf bzw. Ergebnis |

## Kubernetes

Helm-Chart unter `deploy/helm/ai-testing-suite`: Deployments für `web` und `worker`, Service,
Ingress, Migrations-Job als Hook, Secret (oder `existingSecret`) und optional eine einfache
Postgres für Testumgebungen. Für Produktion eine verwaltete Postgres oder CloudNativePG nutzen.

Der Worker braucht Netzwerkzugriff auf die getesteten Endpoints. Läuft vLLM im selben Cluster,
genügt die Service-URL (`http://vllm.<ns>.svc.cluster.local:8000`).

## Ausbaustufen

- Lasttests mit sehr hoher Last als eigene Kubernetes-Jobs (z. B. k6) statt im Worker-Pod.
- Weitere Testtypen: Fallback/Routing in LiteLLM, Long-Context, Kosten-/Spend-Tracking,
  Prompt-Caching, Embeddings/Reranker.
- Export der Kennzahlen nach Prometheus und Benachrichtigung bei Fehlschlägen (Teams/Slack/E-Mail).
- Testdatensätze als eigene, versionierte Objekte statt in der Testkonfiguration.
