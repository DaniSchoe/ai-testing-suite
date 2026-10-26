# AI Testing Suite

Cloud-native Testing Suite für KI-Plattformen auf Kubernetes: LiteLLM-Gateway, vLLM-Server und
MCP-Server. Prüft Performance, Last, Qualität, Coding, OCR, Security/DLP, Berechtigungen,
MCP-Freigaben und Tool-Calling, protokolliert jeden Lauf und zeigt die historische
Entwicklung im Dashboard.

- **Node.js** (Fastify) und **PostgreSQL**, Job-Queue und Zeitpläne ebenfalls in Postgres (pg-boss)
- **Keycloak-Login** (OIDC); **Rollen, Berechtigungen und Teams** werden in der App gepflegt
- **API-Key-Sammlung**: Keys privat, pro Team, global oder einzelnen Usern zugeordnet; Endpoints und Tests wählen nur einen Key aus der Liste
- **Admin-Panel** für Endpoints (AI Proxy, LLM-Endpoint OpenAI-compatible/Claude, MCP) mit Maintainer, Dev/Prod und Veröffentlichung
- **Modellkatalog**: Modelle werden automatisch von LiteLLM und jedem vLLM-Endpunkt abgefragt,
  unterschiedliche Namen desselben Modells werden per Alias zusammengeführt
- **Thinking vs. Non-Thinking**: Genauigkeit, Token-Verbrauch, Latenz und Schlüssigkeit im Vergleich
- **Test-Builder**: ein Test kombiniert beliebige Testarten mit Endpoint, mehreren Modellen und API-Key und läuft sofort, einmalig geplant oder regelmäßig; Veröffentlichung für dich, Teams oder alle
- **Marketplace**: Tests entdecken (Filter nach Testart, privat/öffentlich, Sortierung, Namenssuche), Detailseite, Merkliste; Herausgeber können verlangen, dass andere mit ihrem eigenen API-Key ausführen
- **Zeitpläne** als Kalender mit geplanten und bisherigen Läufen
- Dashboard **global, pro Team oder nutzerspezifisch** mit Filter für Modelle und Endpoints (Standard nur Prod, Dev gezielt für Administratoren, Mehrfachauswahl wird summiert), Gauge für Genauigkeit/Qualität, Lastdiagramm (Antwortzeit × parallele Anfragen) und Netzdiagramm je Modell, Detailtabelle zum Modellprofil und Kacheln für das jeweils beste Modell; Modelldetailseite als Beta-Platzhalter
- **Historie**: Testläufe als aufklappbare Bündel mit bestanden/fehlgeschlagen, Filter nach Team, Endpoint und Modell (vom Dashboard übernommen)
- **KI-Analyse** nach jedem Lauf (Modell im Modellkatalog wählbar), Testarten Qualität (fünf Stufen), Coding und OCR (Rechnung und Prüfbericht als Bild)
- **Plattform**: interaktiver Cluster-Builder (GPUs, NVLink, Inferenzserver, AI-Gateway) mit geschätztem VRAM, Bandbreite, passenden Modellen, Nutzerkapazität und Verhalten unter Last; Live-Metriken (DCGM, vLLM, LiteLLM) und Schätzung gegen Lasttest-Messung
- **Hell-, Dunkel- und System-Modus**
- **Helm-Chart** für Kubernetes

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Schnellstart ohne Keycloak

Voraussetzung: Node.js 22 und eine Postgres (z. B. `docker compose up postgres`).

```bash
npm ci --prefix server && npm ci --prefix web
npm run build --prefix web

cd server
node tools/mock-llm.js &            # Mock-Gateway auf :4000 (OpenAI-API + MCP)
AUTH_MODE=dev node tools/seed.js    # Demo-Endpoints (LiteLLM, vLLM, MCP), API-Keys, 14 Beispieltests
AUTH_MODE=dev npm start             # http://localhost:8080, Login als Dev-Admin
```

Frontend-Entwicklung mit Hot Reload: `npm run dev --prefix web` (Port 5173, API wird an 8080 weitergeleitet).

## Lokal mit Keycloak

```bash
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts   # gleiche Issuer-URL für Browser und App
docker compose up --build
```

Keycloak importiert den Realm `ai-testing` aus `deploy/keycloak/realm-ai-testing.json` mit den
Usern `admin/admin` (über `ADMIN_EMAILS` Admin), `tester/tester`, `viewer/viewer`. Die App läuft auf http://localhost:8080, die Keycloak-Konsole auf http://keycloak:8081.

## Kubernetes

Das Helm-Chart unter `deploy/helm/ai-testing-suite` bringt alles mit: Web- und Worker-Deployment,
Service, Ingress, Migrations-Job, Secret und eine Postgres (StatefulSet) mit eigenem PVC.

```bash
helm install ai-testing deploy/helm/ai-testing-suite \
  --namespace ai-testing --create-namespace \
  --set publicUrl=https://ai-testing.example.com \
  --set ingress.host=ai-testing.example.com \
  --set oidc.issuerUrl=https://keycloak.example.com/realms/ai-testing \
  --set 'adminEmails={admin@example.com}' \
  --set secrets.oidcClientSecret=...
```

- **Postgres**: läuft standardmäßig im Cluster. Das PVC `<release>-postgres-data` (10 Gi) bleibt bei
  `helm uninstall` erhalten. Größe und StorageClass über `postgresql.persistence.size` und
  `postgresql.persistence.storageClassName`, ein vorhandenes Volume über `postgresql.persistence.existingClaim`.
- **Passwörter**: `APP_SECRET` und das Postgres-Passwort werden bei der Installation zufällig erzeugt
  und bei Upgrades beibehalten. Alternativ `secrets.existingSecret` (Keys siehe `values.yaml`).
- **Externe Datenbank** (empfohlen für Produktion): `--set postgresql.enabled=false --set secrets.databaseUrl=postgres://user:pass@host:5432/suite`.
- **Ingress**: `ingress.className` (Standard `nginx`), TLS über `ingress.tls.secretName`, z. B. mit
  cert-manager-Annotation; für lange Lasttests `proxy-read-timeout` erhöhen.
- **Ein einziges Deployment**: `--set worker.embedded=true` führt die Tests in den Web-Pods aus.

Das Image wird von der CI bei jedem Merge nach `main` als `ghcr.io/danischoe/ai-testing-suite` gebaut.

### Keycloak einrichten

`OIDC_ISSUER_URL` (Helm: `oidc.issuerUrl`) muss exakt der Issuer sein, den Keycloak meldet, bei Keycloak
ab Version 17 ohne `/auth`: `https://keycloak.example.com/realms/<realm>`. Prüfen mit
`curl <issuerUrl>/.well-known/openid-configuration` und dem Feld `issuer`. Weicht er ab (z. B. `http://`
statt `https://` oder ein interner Hostname), Keycloak hinter dem Ingress mit `KC_HOSTNAME` und
`KC_PROXY_HEADERS=xforwarded` betreiben oder den gemeldeten Wert als Issuer eintragen. Ein
abschließender `/` ist egal. Als Notlösung übernimmt `OIDC_TRUST_DISCOVERED_ISSUER=true` den gemeldeten Wert.

1. Client `ai-testing-suite`: confidential, Standard Flow, PKCE S256, Redirect-URI `<publicUrl>/auth/callback`,
   Post-Logout-Redirect `<publicUrl>`.
2. Keine Rollen in Keycloak nötig. Keycloak liefert nur die Identität (inkl. bestätigter E-Mail).

### Rollen, Berechtigungen und Teams

- **Admins per E-Mail**: `ADMIN_EMAILS` (Helm: `adminEmails`) listet Keycloak-E-Mails, die immer
  vollen Zugriff haben. Zählt nur, wenn Keycloak die E-Mail als bestätigt meldet (`email_verified`).
- **Rollen** vergibt ein Admin unter *Administrator > Benutzer*. Neue User erhalten beim ersten Login
  die Standardrolle (anfangs *Betrachter*). User lassen sich vorab per E-Mail anlegen.
- **Berechtigungen je Rolle** legst du unter *Administrator > Rollen* in einer Matrix fest. Mitgeliefert
  sind *Administrator* (immer alles), *Tester* und *Betrachter*; weitere Rollen sind frei definierbar.
- **Teams** unter *Administrator > Teams*. Dashboard, "Meine Tests" und Läufe lassen sich nach Team
  filtern. Teammitglieder sehen die Läufe ihres Teams auch ohne "Alle Ergebnisse sehen".
- Niemand kann mehr Rechte vergeben, als er selbst hat; gesperrte User verlieren sofort den Zugriff.

## Konfiguration

| Variable | Bedeutung |
|---|---|
| `DATABASE_URL` | Postgres-Verbindung |
| `APP_SECRET` | Schlüssel für Session-Cookies und Secret-Verschlüsselung (mind. 32 Zeichen) |
| `APP_VERSION` | Version, die oben rechts in der Oberfläche steht (Helm: `appVersion`, Standard aus dem Chart; ohne Wert `dev`) |
| `PUBLIC_URL` | Öffentliche URL, z. B. `https://ai-testing.example.com` |
| `AUTH_MODE` | `oidc` (Standard) oder `dev` (lokal ohne Keycloak) |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Login-Client |
| `OIDC_TRUST_DISCOVERED_ISSUER` | `true` = Issuer aus der Discovery-Antwort übernehmen, auch wenn er von `OIDC_ISSUER_URL` abweicht |
| `ADMIN_EMAILS` | Kommagetrennte Keycloak-E-Mails mit Admin-Zugriff (im Dev-Modus `dev@localhost`) |
| `RUN_WORKER` | Worker im Web-Prozess mitlaufen lassen (lokal `true`, in Kubernetes `false`) |
| `WORKER_CONCURRENCY` | parallele Läufe pro Worker |
| `MIGRATE_ON_START` | Migrationen beim Start ausführen (Standard `true`) |
| `MODEL_SYNC_CRON` | wie oft der Worker die Modelle aller Endpoints abfragt (Standard `*/15 * * * *`) |

## Eigene Tests

Tests entstehen im Test-Builder: Endpoint und Modelle wählen, Testarten ankreuzen (zu jeder Art gibt es eine
Beschreibungsseite unter `/test-types/<art>`), Ausführung festlegen. Pro Testart und Modell entsteht ein
Einzeltest. Die Konfiguration jeder Testart ist JSON, wird mit sinnvollen Standardwerten vorbefüllt und ist
über den Experten-Modus editierbar. Beispiel für einen Berechtigungstest:

```json
{
  "cases": [
    { "apiKey": "team-a", "model": "gpt-oss-120b", "expect": "allow" },
    { "apiKey": "team-a", "model": "llama-3.3-70b", "expect": "deny" },
    { "apiKey": "team-a", "method": "GET", "path": "/key/list", "expect": "deny" },
    { "apiKey": null, "model": "gpt-oss-120b", "expect": "deny", "name": "Ohne Credentials" }
  ]
}
```

`apiKey` nennt einen Key aus der API-Key-Sammlung (Einstellungen > API-Keys) per Namen.

Thinking-Test für ein Qwen3-Modell auf vLLM; für gpt-oss oder über LiteLLM stattdessen
`reasoning_effort` in den Varianten setzen:

```json
{
  "model": "qwen3-32b",
  "judgeModel": "qwen3-32b",
  "variants": [
    { "name": "Thinking", "params": { "chat_template_kwargs": { "enable_thinking": true } } },
    { "name": "Non-Thinking", "params": { "chat_template_kwargs": { "enable_thinking": false } } }
  ]
}
```

Qualität, Coding und OCR bringen eigene Standardaufgaben mit (`cases`, `tasks`, `documents`); eine leere Konfiguration
nutzt immer den aktuellen Standard des Servers. Der OCR-Test braucht ein Modell mit Bildverarbeitung, die
Dokumente liegen in `server/fixtures/ocr` und lassen sich mit `python3 tools/generate-ocr-docs.py` neu erzeugen.
Der Lasttest zieht pro Anfrage einen Prompt aus `prompts` (Schwierigkeit `leicht`, `mittel`, `schwer`, Mischung über `mix`).

Allgemeine Optionen für jeden Test: `timeoutS`, `regressionTolerance` (Standard 0.2), `failOnRegression`.
