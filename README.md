# AI Testing Suite

Cloud-native Testing Suite für KI-Plattformen auf Kubernetes: LiteLLM-Gateway, vLLM-Server und
MCP-Server. Prüft Performance, Last, Qualität, Coding, OCR, Security/DLP, Berechtigungen,
MCP-Freigaben und Tool-Calling und macht die Ergebnisse belastbar: feste Versionen, Schwellwerte,
Baseline-Vergleich, Nachweise mit Hash, Findings, Prüfberichte und ein Dashboard in drei Ebenen.

- **Node.js** (Fastify) und **PostgreSQL**, Job-Queue und Zeitpläne ebenfalls in Postgres (pg-boss)
- **Keycloak-Login** (OIDC); **Mandanten**, Rollen, Berechtigungen und Teams werden in der App gepflegt
- **Ziele**: Plattformen (Dev/Prod) mit Inventar (Rechenzentrum, Server, GPU, Interconnect, Kubernetes, Inferenzserver, AI Gateway, MCP u. a.), Topologie in festen Ebenen mit Konfigurationsleisten, Status, Kill-Switch, Einstufung (Sicherheit, Produktionsreife, Souveränität) und Sizing (Beta). Oben rechts wählst du die Plattform, die Dashboard und alle Listen begrenzt
- **Datensätze**: versionierte Fälle, Dokumente und Bilder mit Hash, Sprache und Sensitivität (Angriffs-Payloads nur mit eigener Berechtigung)
- **Testkatalog**: versionierte Vorlagen mit Test-Ziel (Plattform, LLM, Daten, Prozesse) als Kacheln (Entwurf → Prüfung → Veröffentlicht → Veraltet), Vier-Augen-Freigabe, Import/Export als YAML/JSON, Zuordnung zu AIC4, OWASP LLM Top 10 und SOV; Plattformtest „Netzwerk-Isolation“ (Air-Gap)
- **Modellportfolio**: Modelle erscheinen nicht automatisch; du wählst gefundene Modelle der Endpoints aus und bündelst sie unter einem Namen
- **Prüfungen** verbinden Ziel, Vorlagen in fester Version, Modelle mit Pfad (direkt/Gateway), Schwellwerte, Wiederholungen, Baseline, A/B-Vergleich, Gate und Zeitplan
- **Läufe** mit Ergebnisklassen (bestanden, Qualitätsabweichung, Sicherheitsbefund, technischer Fehler, nicht anwendbar), Snapshot der Plattform, Nachweisen mit Kettenhash und KI-Analyse
- **Freigaben** (Tab in *Prüfungen*) für Prod-Läufe und Lasttests nach dem Vier-Augen-Prinzip mit Zeitfenster, Laufzahl und Lastgrenzen, optional einem Team oder einer Person zugewiesen; ein Warnsymbol an *Prüfungen* zeigt offene Anträge; Kill-Switch sperrt eine Plattform sofort
- **Findings** mit Schwere, Status, Verantwortlichem und Nachtest; **Berichte** mit Freigabe und Export
- **Dashboard** der gewählten Plattform mit Kacheln zu Findings, Berichten, Souveränität und SEAL-Stufe, Scorecard (Konfidenzintervalle), Eignungsprofilen, OWASP-Heatmap und Trend mit Änderungsmarkern; darunter die Modellebene
- **CLI und Gate** für CI/CD mit Service-Token; Exit-Code 0 bestanden, 1 nicht bestanden
- **Hell-, Dunkel- und System-Modus**, **Helm-Chart** für Kubernetes

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Schnellstart ohne Keycloak

Voraussetzung: Node.js 22 und eine Postgres (z. B. `docker compose up postgres`).

```bash
npm ci --prefix server && npm ci --prefix web
npm run build --prefix web

cd server
node tools/mock-llm.js &            # Mock-Gateway auf :4000 (OpenAI-API + MCP)
AUTH_MODE=dev node tools/seed.js    # Dev- und Prod-Plattform (LiteLLM, vLLM, MCP), API-Keys, acht Beispielprüfungen
AUTH_MODE=dev npm start             # http://localhost:8080, Login als Dev-Admin
node tools/e2e-check.js             # End-to-End-Prüfung gegen den laufenden Server und den Mock
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

### Mandanten, Rollen und Teams

- **Mandanten** trennen Plattformen, Datensätze, Vorlagen (eigene), Prüfungen, Zugangsdaten, Läufe, Findings und Berichte. Offizielle Vorlagen und Datensätze gelten für alle. Der Mandant wird oben gewählt (Header `X-Tenant-Id`); bestehende Daten liegen im Mandanten „Standard“.
- **Admins per E-Mail**: `ADMIN_EMAILS` (Helm: `adminEmails`) listet Keycloak-E-Mails, die immer
  vollen Zugriff haben. Zählt nur, wenn Keycloak die E-Mail als bestätigt meldet (`email_verified`).
- **Rollen** sind global definiert und werden je Mandant vergeben (*Administration › Systemeinstellungen › User*). Mitgeliefert:
  *Administrator*, *Engagement Lead* (Prod-Freigaben, Berichte, Findings, Mitglieder), *Test Engineer*,
  *Red Teamer* (sieht Angriffs-Payloads), *Reviewer* (gibt Vorlagen und Berichte frei), *Kunden-Viewer*
  (nur Plattform- und Berichtsebene) und *Service Account* (CI/CD). Weitere Rollen sind frei definierbar.
- **Vier-Augen-Prinzip** gilt für Katalogfreigaben, Prod-Läufe und Berichte: Wer einreicht oder beantragt, entscheidet nicht – auch nicht in einem Ein-Personen-Setup.
- **Service-Tokens** (`sat_…`, *Plattform › Keys*) gelten für einen Mandanten und dürfen Prüfungen starten und Ergebnisse lesen.
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
| `RETENTION_CRON` | wann Nachweise nach Ablauf der Aufbewahrung bereinigt werden (Standard `17 3 * * *`; Fristen unter *Administration › Systemeinstellungen*) |
| `IMPRINT_COMPANY`, `IMPRINT_ADDRESS`, `IMPRINT_EMAIL`, `IMPRINT_PHONE`, `IMPRINT_REGISTER`, `IMPRINT_REPRESENTED_BY` | Impressum auf der Info-Seite (Helm: `info.imprint.*`); ohne Angabe entfällt die Kachel |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_URL`, `SUPPORT_HOURS` | Support-Kachel auf der Info-Seite (Helm: `info.support.*`) |
| `COPYRIGHT_HOLDER` | Name im Copyright-Hinweis am Seitenende (Helm: `info.copyright`, Standard `ORCA`) |
| `BRANDING_DIR` | Ordner mit `favicon.png` und `company-logo.png`, die die mitgelieferten Bilder ersetzen (Helm: `branding.existingConfigMap`) |

### Favicon und Firmenlogo

Beide Bilder sind PNG-Dateien. Mitgeliefert sind Platzhalter in `web/public/favicon.png` (Browser-Tab und Logo links oben) und `web/public/company-logo.png` (Copyright-Hinweis unten). Zum Austauschen die Dateien dort ersetzen und das Frontend neu bauen, oder zur Laufzeit `BRANDING_DIR` auf einen Ordner mit gleich benannten Dateien setzen (in Kubernetes eine ConfigMap: `kubectl create configmap branding --from-file=favicon.png --from-file=company-logo.png`, dann `branding.existingConfigMap=branding`).

### Metriken (Beta)

Komponenten mit Metrics-Endpunkt (GPU/DCGM, Inferenzserver/vLLM, AI Gateway/LiteLLM) werden vom Worker im eingestellten Intervall abgefragt (Standard 30 s, Aufbewahrung 24 h). Die Dashboards stehen unter *Übersicht › Metriken*, Intervall, Aufbewahrung und Endpunktstatus unter *Systemeinstellungen › Metriken*.

## Prüfungen und Vorlagen

Der Weg zu einem belastbaren Ergebnis, am Beispiel OCR:

1. **Datensatz** hochladen (*Katalog › Datensätze*): Dokumente als Bilder und eine CSV/JSONL mit den erwarteten Feldern samt Typ (Zahl mit Toleranz, Datum, IBAN, Wahrheitswert, Stichwörter, exakt).
2. **Vorlage** anlegen (*Katalog › Vorlagen*): Testart OCR, Datensatz in fester Version, Voraussetzung „Vision“, Gewichte je Feld. Ein Reviewer gibt sie frei.
3. **Prüfung** anlegen (*Prüfen › Prüfungen*): Plattform, Vorlage, Modelle, Schwellwerte (z. B. `score >= 0.9`), Wiederholungen, Zeitplan.
4. **Lauf** starten. Modelle ohne Vision gelten als „nicht anwendbar“, nicht als Fehler. Das Ergebnis geht gegen die Schwellwerte und die Baseline; der Bericht entsteht automatisch.

Ein **Testlauf** direkt aus dem Katalog (auch für Entwürfe) zählt nicht in Läufen oder Dashboard.

Die Konfiguration einer Vorlage (`config`, `scoring`, `params`) ist JSON mit sinnvollen Standardwerten; ohne Datensatz nutzt die Testart ihre eingebauten Fälle. Beispiel für einen Berechtigungstest:

```json
{
  "cases": [
    { "apiKey": "team-a", "model": "gpt-oss-120b", "expect": "allow" },
    { "apiKey": "team-a", "method": "GET", "path": "/key/list", "expect": "deny" },
    { "apiKey": null, "model": "gpt-oss-120b", "expect": "deny", "name": "Ohne Credentials" }
  ]
}
```

`apiKey` nennt einen Key aus den Zugangsdaten per Namen. Schwellwerte sind Regeln wie `{ "metric": "latency_ms_p95", "op": "<", "value": 8000 }`; für Zugriffstests gilt immer: ein falsch erlaubter Zugriff ist ein Befund.

Der OCR-Test braucht ein Modell mit Bildverarbeitung; die mitgelieferten Dokumente liegen in `server/fixtures/ocr` und lassen sich mit `python3 tools/generate-ocr-docs.py` neu erzeugen.

## CI/CD

```bash
export SAT_URL=https://ai-testing.example.com SAT_TOKEN=sat_… SAT_TENANT=<mandant-id>
node server/tools/cli.js run "Prod-Abnahme" --wait --junit ergebnis.xml   # Exit 0 bestanden, 1 Gate nicht bestanden
node server/tools/cli.js gate <lauf-id>                                     # Gate eines vorhandenen Laufs
node server/tools/cli.js audits                                             # sichtbare Prüfungen
```

Exit-Code 2 bedeutet Fehler (Verbindung, Token), 3 fehlende Freigabe oder gesperrte Plattform. Was die Pipeline scheitern lässt, legt die Prüfung als Gate fest (Sicherheitsbefund, technischer Fehler, Qualitätsabweichung, Regression).
