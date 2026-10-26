import { avg } from '../runner/clients.js';
import { matchTypedField } from './assertions.js';

const TYPE_HINT = { number: 'Zahl', bool: 'true oder false', date: 'Datum im Format YYYY-MM-DD', iban: 'IBAN', exact: 'Text', text: 'Text', keywords: 'Text' };

// JSON-Objekt aus einer Antwort lesen (auch aus einem Codeblock); null, wenn keines gültig ist.
export function extractJson(text) {
  try {
    const parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Anweisung an das Modell: Aufgabe der Vorlage, Besonderheiten des Dokuments und das erwartete JSON-Format aus den Feldern der Ground Truth.
export function buildPrompt(instruction, doc) {
  const shape = Object.entries(doc.fields)
    .map(([name, f]) => `"${name}": <${TYPE_HINT[f.type] ?? 'Text'}${f.hint ? `: ${f.hint}` : ''}>`)
    .join(', ');
  return `${instruction}${doc.prompt ? ` ${doc.prompt}` : ''}\nAntworte ausschließlich mit einem JSON-Objekt in diesem Format: {${shape}}`;
}

// Score und Aufschlüsselung je Feld; weights gewichtet einzelne Felder (Standard 1).
export function scoreFields(doc, parsed, weights = {}) {
  const fields = Object.entries(doc.fields).map(([name, spec]) => {
    const got = parsed ? parsed[name] : undefined;
    return { field: name, type: spec.type, ok: parsed ? matchTypedField(spec, got) : false, got: got ?? null, expected: spec.value, weight: Number(weights[name] ?? 1) };
  });
  const total = fields.reduce((n, f) => n + f.weight, 0);
  const earned = fields.filter((f) => f.ok).reduce((n, f) => n + f.weight, 0);
  return { fields, score: total ? earned / total : 0 };
}

export default {
  type: 'ocr',
  label: 'OCR',
  description:
    'Liest Dokumente als Bild und vergleicht die extrahierten Felder mit der Ground Truth des Datensatzes (typisiert: Zahl mit Toleranz, Datum, IBAN, Wahrheitswert, Text). Benötigt ein Modell mit Bildverarbeitung (Vision).',
  defaults: {
    model: '',
    maxTokens: 2048,
    temperature: 0,
    instruction: 'Extrahiere die Felder des abgebildeten Dokuments.',
    // Feldgewichte, z. B. { netto: 2, iban: 2 }
    weights: {},
    // invalid_json: fail_case (Fall gilt als falsch) oder retry_once (einmal nachfragen)
    invalidJson: 'fail_case',
    documents: [],
  },
  async run(ctx) {
    const c = ctx.config;
    const model = ctx.model();
    const llm = ctx.llm();
    const cases = [];
    if (!c.documents?.length) throw new Error('Kein Dokumentdatensatz zugeordnet');
    for (const doc of c.documents) {
      if (ctx.signal.aborted) break;
      try {
        if (!doc.dataUrl) throw new Error(`Datei "${doc.file}" ist kein Bild (PDF-Seiten als PNG hochladen)`);
        const prompt = buildPrompt(c.instruction, doc);
        const ask = (text) =>
          llm.chat({
            model,
            temperature: c.temperature ?? 0,
            max_tokens: c.maxTokens,
            messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: doc.dataUrl } }] }],
          });
        let res = await ask(prompt);
        let parsed = extractJson(res.content);
        let attempts = 1;
        if (!parsed && c.invalidJson === 'retry_once') {
          res = await ask(`${prompt}\nDeine letzte Antwort war kein gültiges JSON. Antworte jetzt nur mit dem JSON-Objekt.`);
          parsed = extractJson(res.content);
          attempts = 2;
        }
        const { fields, score } = scoreFields(doc, parsed, c.weights);
        cases.push({
          name: doc.name,
          category: doc.category,
          ok: fields.every((f) => f.ok),
          validJson: Boolean(parsed),
          attempts,
          fields,
          score,
          prompt,
          notes: fields.map((f) => `${f.ok ? '✓' : '✕'} ${f.field}: erwartet ${JSON.stringify(f.expected)}, gelesen ${JSON.stringify(f.got)}`),
          latencyMs: Math.round(res.latencyMs),
          tokens: res.usage?.total_tokens ?? null,
          response: res.content.slice(0, 1200),
        });
        if (!fields.every((f) => f.ok)) ctx.log('warn', `${doc.name}: Felder falsch oder fehlend: ${fields.filter((f) => !f.ok).map((f) => f.field).join(', ')}`);
      } catch (err) {
        cases.push({ name: doc.name, category: doc.category, ok: false, validJson: false, score: 0, fields: [], error: err.message });
      }
    }
    const fields = cases.flatMap((x) => x.fields);
    const weightTotal = fields.reduce((n, f) => n + f.weight, 0);
    const score = weightTotal ? fields.filter((f) => f.ok).reduce((n, f) => n + f.weight, 0) / weightTotal : 0;
    const byType = {};
    for (const f of fields) {
      byType[f.type] ??= { ok: 0, total: 0 };
      byType[f.type].total += 1;
      if (f.ok) byType[f.type].ok += 1;
    }
    const answered = cases.filter((x) => !x.error);
    return {
      // Ohne Schwellwerte in der Prüfung gilt ein Score von mindestens 0,7.
      status: score >= (c.minScore ?? 0.7) ? 'passed' : 'failed',
      model,
      score,
      metrics: {
        cases: cases.length,
        passed: cases.filter((x) => x.ok).length,
        fields_correct: fields.filter((f) => f.ok).length,
        fields_total: fields.length,
        field_accuracy: score,
        valid_json_rate: answered.length ? answered.filter((x) => x.validJson).length / answered.length : 0,
        latency_ms_avg: avg(cases.filter((x) => x.latencyMs).map((x) => x.latencyMs)),
        tokens_per_doc: avg(cases.filter((x) => x.tokens).map((x) => x.tokens)),
        ...Object.fromEntries(Object.entries(byType).map(([t, v]) => [`accuracy:${t}`, v.ok / v.total])),
      },
      details: { cases },
    };
  },
};
