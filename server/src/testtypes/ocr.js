import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll } from './assertions.js';
import { avg } from '../runner/clients.js';

const DIR = fileURLToPath(new URL('../../fixtures/ocr/', import.meta.url));
const IMAGE_NAME = /^[\w.-]+\.(png|jpe?g)$/i;

// Zwei Dokumente (erzeugt mit tools/generate-ocr-docs.py; PDF und die an das Modell gesendete PNG-Seite liegen in fixtures/ocr).
// Jedes Dokument hat mehrere Felder; der Score ist der Anteil richtig gelesener Felder.
export const OCR_DOCUMENTS = [
  {
    name: 'Rechnung (strukturiert, PDF)',
    image: 'rechnung.png',
    prompt:
      'Das Bild zeigt eine Rechnung über einen Einkauf. Werte die Positionen aus und rechne selbst nach. Antworte ausschließlich mit JSON in diesem Format: ' +
      '{"rechnungsbetrag": <Bruttobetrag in Euro als Zahl>, "stueckzahl": <Summe aller Mengen über alle Positionen>, ' +
      '"summe_7_prozent": <Summe der Gesamtpreise aller Positionen mit 7 % MwSt in Euro>, "teuerste_position": "<Artikelname der Position mit dem höchsten Gesamtpreis>"}',
    expect: { rechnungsbetrag: 270.55, stueckzahl: 45, summe_7_prozent: 84.45, teuerste_position: { keywords: ['druckerpatrone'] } },
  },
  {
    name: 'Prüfbericht (Handschrift und Unterschriften)',
    image: 'pruefbericht.png',
    prompt:
      'Das Bild zeigt einen Prüfbericht. Unten gibt es zwei Unterschriftenfelder und einen handschriftlichen Hinweis. Antworte ausschließlich mit JSON in diesem Format: ' +
      '{"unterschriften_vorhanden": <true, wenn beide Felder unterschrieben sind, sonst false>, "anzahl_unterschriften": <Zahl der tatsächlich vorhandenen Unterschriften>, ' +
      '"handschriftlicher_hinweis": "<der handschriftliche Hinweis, wörtlich oder sinngemäß>"}',
    expect: {
      unterschriften_vorhanden: true,
      anzahl_unterschriften: 2,
      handschriftlicher_hinweis: { keywords: ['brems', 'links', '500', 'dicht'], min: 3 },
    },
  },
];

export default {
  type: 'ocr',
  label: 'OCR',
  description:
    'Liest zwei Dokumente als Bild: eine Rechnung (Positionen und Preise aggregieren) und einen Prüfbericht mit Handschrift und zwei Unterschriften. Benötigt ein Modell mit Bildverarbeitung (Vision).',
  defaults: { model: '', minScore: 0.7, maxTokens: 2048, documents: OCR_DOCUMENTS },
  async run(ctx) {
    const model = ctx.model();
    const llm = ctx.llm();
    const cases = [];
    for (const doc of ctx.config.documents) {
      if (ctx.signal.aborted) break;
      try {
        // Nur Dateien aus fixtures/ocr, damit eine bearbeitete Konfiguration keine beliebigen Dateien liest.
        if (!IMAGE_NAME.test(doc.image)) throw new Error(`Ungültiger Bildname "${doc.image}"`);
        const png = await readFile(path.join(DIR, doc.image));
        const res = await llm.chat({
          model,
          temperature: ctx.config.temperature ?? 0,
          max_tokens: ctx.config.maxTokens,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: doc.prompt },
                { type: 'image_url', image_url: { url: `data:image/${/\.png$/i.test(doc.image) ? 'png' : 'jpeg'};base64,${png.toString('base64')}` } },
              ],
            },
          ],
        });
        const verdict = await checkAll([{ type: 'json_match', expect: doc.expect }], res.content, ctx);
        const fields = verdict.outcomes[0].fields ?? [];
        cases.push({
          name: doc.name,
          ok: verdict.ok,
          fields,
          score: fields.length ? fields.filter((f) => f.ok).length / fields.length : 0,
          notes: fields.map((f) => `${f.ok ? '✓' : '✕'} ${f.field}: ${JSON.stringify(f.got)}`),
          latencyMs: Math.round(res.latencyMs),
          answer: res.content.slice(0, 1200),
        });
        if (!verdict.ok) ctx.log('warn', `${doc.name}: ${verdict.outcomes[0].message}`, { fields });
      } catch (err) {
        cases.push({ name: doc.name, ok: false, score: 0, fields: [], error: err.message });
      }
    }
    const fields = cases.flatMap((c) => c.fields);
    const score = fields.length ? fields.filter((f) => f.ok).length / fields.length : 0;
    return {
      status: score >= ctx.config.minScore ? 'passed' : 'failed',
      model,
      score,
      metrics: {
        cases: cases.length,
        passed: cases.filter((c) => c.ok).length,
        fields_correct: fields.filter((f) => f.ok).length,
        fields_total: fields.length,
        latency_ms_avg: avg(cases.filter((c) => c.latencyMs).map((c) => c.latencyMs)),
      },
      details: { cases },
    };
  },
};
