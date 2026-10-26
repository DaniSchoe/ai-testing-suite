// Beschreibung der Testarten für den Test-Builder und die Info-Seiten: Icon, Zweck, Ablauf, Kennzahlen.
import { Activity, BadgeCheck, Braces, Brain, Code, Gauge, HeartPulse, Lock, Plug, ScanText, ShieldAlert } from 'lucide-react';

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
    summary: 'Lasttest mit stufenweise steigender Parallelität und wechselnden Prompts, direkt aus dem Pod der Anwendung.',
    steps: [
      'Läuft in Stufen (Dauer und Parallelität je Stufe, z. B. 5, 20, 50 gleichzeitige Anfragen).',
      'Jede Anfrage zieht einen anderen Prompt aus einem Pool mit leichten, mittleren und schweren Aufgaben (kurze Fakten bis lange Ausgaben). Ein vorangestellter Zufallswert verhindert, dass Prefix-Caches die Last verfälschen.',
      'Misst je Stufe Durchsatz, Fehlerquote, p95-Latenz (auch je Schwierigkeit) und wie viele Anfragen das Gateway gedrosselt hat (HTTP 429).',
    ],
    metrics: ['Durchsatz je Stufe', 'p95-Latenz je Stufe und Schwierigkeit', 'Fehlerquote', 'Gedrosselte Anfragen (429)', 'Spitzen-Requests pro Sekunde'],
    when: 'Vor Releases und zur Kapazitätsplanung. Erzeugt echte Last auf dem Endpoint. Rate-Limits zeigen sich hier als 429.',
  },
  quality: {
    Icon: BadgeCheck,
    summary: 'Fünf Fragen von leicht bis extrem schwer; die höchste Stufe lösen nur sehr große Modelle.',
    steps: [
      'Stellt fünf Fragen mit eindeutiger Lösung: Logik (Stufe 1), Textaufgabe (2), Code nachvollziehen (3), Wahrscheinlichkeit (4) und Kombinatorik mit Nebenbedingung (5).',
      'Das Modell schließt jede Antwort mit „Antwort: …“; verglichen wird nur dieser Wert, nicht der Rechenweg.',
      'Der Score gewichtet die Fälle nach Stufe (1 bis 5) und muss den Mindestscore (Standard 60 %) erreichen. Kleine Modelle bleiben bei den leichten Stufen hängen, große kommen weiter.',
    ],
    metrics: ['Score (Genauigkeit)', 'Höchste gelöste Stufe', 'Bestandene Fälle', 'Durchschnittliche Latenz'],
    when: 'Um Qualitätsverluste nach Modellwechseln oder Quantisierung zu erkennen und Modelle zu unterscheiden.',
  },
  coding: {
    Icon: Code,
    summary: 'Das Modell löst eine einfache und eine komplexe Programmieraufgabe; der Code wird ausgeführt und geprüft.',
    steps: [
      'Aufgabe 1 (einfach): eine Palindrom-Prüfung. Aufgabe 2 (komplex): ein Parser für Rechenausdrücke mit Klammern, Vorrang und unärem Minus, ohne eval.',
      'Der Code aus der Antwort läuft in einem isolierten Prozess (ohne Dateizugriff, Netzwerk und Umgebungsvariablen) gegen vorbereitete Testfälle.',
      'Der Score ist der Anteil bestandener Testfälle; die komplexe Aufgabe zählt doppelt.',
    ],
    metrics: ['Score', 'Bestandene Tests je Aufgabe', 'Durchschnittliche Latenz'],
    when: 'Wenn ein Modell für Code-Assistenz oder Agenten eingesetzt werden soll.',
  },
  ocr: {
    Icon: ScanText,
    summary: 'Liest zwei Dokumente als Bild: eine Rechnung und einen Prüfbericht mit Handschrift und Unterschriften.',
    steps: [
      'Dokument 1: eine strukturierte Rechnung (PDF). Das Modell liest die Positionen und aggregiert: Rechnungsbetrag, Stückzahl, Summe der Positionen mit 7 % MwSt und teuerste Position.',
      'Dokument 2: ein Prüfbericht mit zwei handschriftlichen Unterschriften und einem handschriftlichen Hinweis. Das Modell erkennt, ob beide Unterschriften vorhanden sind, und gibt den Hinweis wieder.',
      'Der Score ist der Anteil richtig gelesener Felder. Das Modell muss Bilder verarbeiten können (Vision).',
    ],
    metrics: ['Score', 'Richtige Felder', 'Durchschnittliche Latenz'],
    when: 'Um Vision-Modelle für Dokumentenverarbeitung zu vergleichen.',
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
