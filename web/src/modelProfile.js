// Modellprofil: Rohwerte je Modell auf 0 bis 100 abbilden (höher ist besser). Dashboard, Netzdiagramm,
// Detailtabelle und Bestenkacheln verwenden dieselben Kategorien.
import { fmt } from './lib.jsx';

const decay = (v, ref) => (v == null ? null : 100 / (1 + Number(v) / ref));
const share = (v) => (v == null ? null : Number(v) * 100);

export const PROFILE_AXES = [
  { key: 'latency', label: 'Antwortzeit', score: (m) => decay(m.latency_ms, 2000), display: (m) => fmt.ms(m.latency_ms) },
  { key: 'ttft', label: 'TTFT', score: (m) => decay(m.ttft_ms, 500), display: (m) => fmt.ms(m.ttft_ms) },
  {
    key: 'tokens',
    label: 'Tokens/s',
    score: (m) => (m.tokens_per_s == null ? null : (100 * Number(m.tokens_per_s)) / (Number(m.tokens_per_s) + 30)),
    display: (m) => (m.tokens_per_s == null ? '–' : `${fmt.num(m.tokens_per_s, 0)} Tokens/s`),
  },
  { key: 'quality', label: 'Qualität', score: (m) => share(m.quality), display: (m) => fmt.pct(m.quality == null ? null : Number(m.quality)) },
  { key: 'coding', label: 'Coding', score: (m) => share(m.coding), display: (m) => fmt.pct(m.coding == null ? null : Number(m.coding)) },
  { key: 'ocr', label: 'OCR', score: (m) => share(m.ocr), display: (m) => fmt.pct(m.ocr == null ? null : Number(m.ocr)) },
  {
    key: 'load',
    label: 'Last-Performance (Stabilität)',
    score: (m) => share(m.load_score),
    display: (m) => fmt.pct(m.load_score == null ? null : Number(m.load_score)),
  },
  {
    key: 'thinking',
    label: 'Thinking',
    score: (m) => share(m.thinking_share),
    display: (m) => fmt.pct(m.thinking_share == null ? null : Number(m.thinking_share)),
  },
];

export function profileAxes(m) {
  return PROFILE_AXES.map((a) => {
    const value = a.score(m);
    return { label: a.label, value: value ?? 0, display: value == null ? '–' : a.display(m), missing: value == null };
  });
}

const mean = (list) => {
  const v = list.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const axis = (key) => PROFILE_AXES.find((a) => a.key === key);

// Kombinierte Kennzahlen (0 bis 100) für die Bestenkacheln.
export const qualityScore = (m) => mean(['quality', 'coding', 'ocr'].map((k) => axis(k).score(m)));
export const speedScore = (m) => mean(['ttft', 'tokens', 'latency'].map((k) => axis(k).score(m)));

// Bestes Modell je Kategorie: { key, title, model, value, detail } oder model = null ohne Daten.
export function bestModels(profiles = []) {
  const best = (score) => {
    let top = null;
    for (const m of profiles) {
      const v = score(m);
      if (v != null && (!top || v > top.value)) top = { m, value: v };
    }
    return top;
  };
  const q = best(qualityScore);
  const s = best(speedScore);
  const l = best((m) => axis('load').score(m));
  const r = best((m) => m.runs);
  return [
    {
      key: 'quality',
      title: 'Qualität',
      model: q?.m.model,
      score: q ? `${Math.round(q.value)} / 100` : '–',
      detail: q ? `Ø aus Qualität, Coding und OCR` : 'Noch keine Qualitätsdaten',
    },
    {
      key: 'speed',
      title: 'Geschwindigkeit',
      model: s?.m.model,
      score: s ? `${Math.round(s.value)} / 100` : '–',
      detail: s ? `TTFT ${fmt.ms(s.m.ttft_ms)} · ${fmt.num(s.m.tokens_per_s, 0)} Tokens/s · ${fmt.ms(s.m.latency_ms)}` : 'Noch keine Performance-Daten',
    },
    {
      key: 'stability',
      title: 'Stabilität',
      model: l?.m.model,
      score: l ? fmt.pct(l.m.load_score) : '–',
      detail: l ? 'Last-Performance aus den Lasttests' : 'Noch keine Lasttests',
    },
    {
      key: 'runs',
      title: 'Meiste Testläufe',
      model: r?.m.model,
      score: r ? `${r.m.runs} Läufe` : '–',
      detail: r ? `${r.m.results} Testergebnisse` : 'Noch keine Läufe',
    },
  ];
}
