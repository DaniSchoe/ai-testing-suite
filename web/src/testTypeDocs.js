// Beschreibung der Testarten für den Test-Builder und die Info-Seiten: Icon, Zweck, Ablauf, Kennzahlen.
import { Activity, BadgeCheck, Braces, Brain, Gauge, HeartPulse, Lock, Plug, Scale, ShieldAlert, Timer } from 'lucide-react';

export const TYPE_DOCS = {
  smoke: {
    Icon: HeartPulse,
    summary: 'Schneller Gesundheitscheck: Ist der Endpoint erreichbar und antworten die Modelle?',
    steps: [
      'Fragt die Modellliste des Endpoints ab (/v1/models) und misst die Dauer.',
      'Prüft, ob alle erwarteten Modelle gelistet sind (gewählte Modelle bzw. alle bekannten).',
      'Schickt je Modell eine Mini-Anfrage (Standard: „Antworte nur mit OK.“) und wertet Antwort und Fehler aus.',
    ],
    metrics: ['Erwartete und gesunde Modelle', 'Dauer der Modellabfrage', 'Fehler je Modell'],
    when: 'Als häufiger Zeitplan, z. B. alle 5 Minuten, um Ausfälle früh zu sehen.',
  },
  performance: {
    Icon: Gauge,
    summary: 'Misst Antwortzeit, Time-to-first-Token und Token-Durchsatz bei fester Parallelität.',
    steps: [
      'Sendet eine konfigurierbare Zahl von Streaming-Anfragen mit fester Parallelität an das Modell.',
      'Misst je Anfrage Time-to-first-Token (TTFT), Gesamtlatenz und Tokens pro Sekunde.',
      'Berechnet Median und p95, Fehlerquote und vergleicht mit dem letzten bestandenen Lauf (Regressionsprüfung).',
    ],
    metrics: ['TTFT p50/p95', 'Latenz p50/p95', 'Tokens pro Sekunde', 'Fehlerquote'],
    when: 'Nach Modell-, Gateway- oder Infrastrukturänderungen und regelmäßig für Trends.',
  },
  load: {
    Icon: Activity,
    summary: 'Lasttest mit stufenweise steigender Parallelität, direkt aus dem Pod der Anwendung.',
    steps: [
      'Läuft in Stufen (Dauer und Parallelität je Stufe, z. B. 2, 8, 16 gleichzeitige Anfragen).',
      'Misst je Stufe Durchsatz, Fehlerquote und p95-Latenz.',
      'Zeigt, ab welcher Parallelität Antwortzeiten steigen oder Fehler auftreten.',
    ],
    metrics: ['Durchsatz je Stufe', 'p95-Latenz je Stufe', 'Fehlerquote', 'Spitzen-Requests pro Sekunde'],
    when: 'Vor Releases und zur Kapazitätsplanung. Erzeugt echte Last auf dem Endpoint.',
  },
  quality: {
    Icon: BadgeCheck,
    summary: 'Prüft Antworten gegen einen Testdatensatz mit Regeln, Regex, JSON oder LLM-as-a-Judge.',
    steps: [
      'Stellt jede Frage des Datensatzes an das Modell.',
      'Bewertet die Antwort je Fall: enthält/enthält nicht, Regex, gültiges JSON oder Urteil eines Judge-Modells.',
      'Der Score ist der Anteil bestandener Fälle; er muss den Mindestscore (Standard 80 %) erreichen.',
    ],
    metrics: ['Score (Genauigkeit)', 'Bestandene Fälle', 'Durchschnittliche Latenz'],
    when: 'Um Qualitätsverluste nach Modellwechseln oder Quantisierung zu erkennen.',
  },
  comparison: {
    Icon: Scale,
    summary: 'Vergleicht mehrere Modelle oder Endpoints auf demselben Datensatz.',
    steps: [
      'Führt denselben Datensatz gegen jedes gewählte Modell aus, auch gegen unterschiedliche Endpoints (z. B. LiteLLM vs. vLLM direkt).',
      'Berechnet je Ziel Score, Latenz und Tokens.',
      'Erstellt eine Rangliste und nennt das beste Ziel.',
    ],
    metrics: ['Score je Modell', 'Latenz je Modell', 'Bestes Modell'],
    when: 'Bei der Modellauswahl und um Unterschiede zwischen Gateway und Direktzugriff zu finden.',
  },
  security: {
    Icon: ShieldAlert,
    summary: 'Prüft Schutz vor Prompt Injection, Jailbreaks, schädlichen Anfragen und Datenabfluss (DLP).',
    steps: [
      'Sendet Angriffs- und DLP-Prompts aus einem Katalog (Prompt Injection, Jailbreak, PII im Prompt, PII in Antworten).',
      'Wertet aus, ob das Modell bzw. die Guardrails des Gateways korrekt ablehnen, maskieren oder blockieren.',
      'Fasst die Ergebnisse je Kategorie zusammen und zählt, wie viele das Gateway abgefangen hat.',
    ],
    metrics: ['Bestehensquote je Kategorie', 'Vom Gateway geblockt', 'Bestandene Fälle'],
    when: 'Regelmäßig nach Änderungen an Guardrails, Systemprompts oder Modellen.',
  },
  access: {
    Icon: Lock,
    summary: 'Prüft je API-Key, welche Modelle und Routen erlaubt oder verweigert werden.',
    steps: [
      'Führt Fälle aus: API-Key, Modell oder Route und die erwartete Antwort (erlaubt oder verweigert).',
      'Vergleicht das tatsächliche Verhalten mit der Erwartung, auch ohne Credentials.',
      'Meldet „falsch erlaubt“ (kritisch) und „falsch verweigert“ getrennt.',
    ],
    metrics: ['Bestandene Fälle', 'Falsch erlaubt', 'Falsch verweigert'],
    when: 'Nach Änderungen an Teams, Budgets, Virtual Keys oder Freigaben im Gateway.',
  },
  mcp: {
    Icon: Plug,
    summary: 'Testet einen MCP-Server oder das MCP-Gateway: Tools, Aufrufe und Freigaben je API-Key.',
    steps: [
      'Verbindet sich per Streamable HTTP und initialisiert die Sitzung.',
      'Listet die sichtbaren Tools je API-Key und prüft erwartete sowie verbotene Tools.',
      'Ruft Tools mit Beispielargumenten auf und prüft Freigabe und Ergebnis.',
    ],
    metrics: ['Bestandene Prüfungen', 'Geleakte (verbotene) Tools', 'Tool-Katalog je Key'],
    when: 'Wenn MCP-Server angebunden oder Tool-Freigaben geändert werden.',
  },
  ratelimit: {
    Icon: Timer,
    summary: 'Prüft, ob Rate-Limits und Budgets greifen (HTTP 429).',
    steps: [
      'Sendet einen Burst von Anfragen in kurzer Zeit an das Modell.',
      'Erwartet ab dem konfigurierten Limit (z. B. 10 pro Minute) HTTP 429.',
      'Vergleicht erfolgreiche und limitierte Anfragen mit dem erwarteten Limit innerhalb einer Toleranz.',
    ],
    metrics: ['Erfolgreiche Anfragen', 'Limitierte Anfragen (429)', 'Sonstige Fehler'],
    when: 'Nach Änderungen an RPM-/TPM-Limits oder Budgets pro Key und Team.',
  },
  structured: {
    Icon: Braces,
    summary: 'Prüft Tool-Calling und strukturierte JSON-Ausgaben.',
    steps: [
      'Stellt Aufgaben mit Tool-Definitionen und erwartet einen korrekten Tool-Aufruf (Name, gültige Argumente).',
      'Prüft JSON-Schema-Ausgaben auf Gültigkeit.',
      'Der Score ist der Anteil korrekter Fälle; er muss den Mindestscore erreichen.',
    ],
    metrics: ['Score', 'Bestandene Fälle'],
    when: 'Für Agenten- und Tool-Anwendungen, besonders nach Modellwechseln.',
  },
  thinking: {
    Icon: Brain,
    summary: 'Vergleicht Thinking- und Non-Thinking-Varianten auf denselben Aufgaben.',
    steps: [
      'Führt dieselben Aufgaben mit und ohne Reasoning aus (je nach Modell über Chat-Template oder reasoning_effort).',
      'Misst Genauigkeit, Token-Verbrauch inklusive Reasoning-Tokens, Latenz und Tokens pro richtiger Antwort.',
      'Ein Judge-Modell bewertet die Schlüssigkeit der Begründung.',
    ],
    metrics: ['Genauigkeit je Variante', 'Tokens und Reasoning-Tokens', 'Latenz', 'Tokens pro richtiger Antwort', 'Schlüssigkeit'],
    when: 'Um zu entscheiden, ob sich Thinking für einen Anwendungsfall lohnt.',
  },
};

export const typeIcon = (type) => TYPE_DOCS[type]?.Icon ?? Gauge;
