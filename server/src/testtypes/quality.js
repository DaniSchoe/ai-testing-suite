import { buildMessages, checkAll } from './assertions.js';
import { avg } from '../runner/clients.js';

const PYTHON_FIB = `def f(n, memo={}):
    if n in memo:
        return memo[n]
    memo[n] = n if n < 2 else f(n - 1) + f(n - 2)
    return memo[n]

print(sum(f(i) for i in range(10)))`;

const FORMAT = 'Denke sorgfältig nach und schließe mit einer eigenen Zeile "Antwort: <Ergebnis>".';

// Fünf Fragen von leicht bis extrem schwer. Jede hat eine eindeutige, maschinell prüfbare Lösung; die Schwierigkeit
// gibt zugleich das Gewicht im Score vor (1 bis 5). Stufe 5 (Kombinatorik mit Nebenbedingung) lösen nur sehr große Modelle zuverlässig.
export const QUALITY_CASES = [
  {
    name: 'Stufe 1 · Ordnungsrelation',
    difficulty: 1,
    prompt: `Anna ist älter als Ben. Ben ist älter als Carla. Wer von den dreien ist die Jüngste? ${FORMAT}`,
    assert: [{ type: 'answer', value: 'Carla' }],
  },
  {
    name: 'Stufe 2 · Textaufgabe',
    difficulty: 2,
    prompt: `Ein Zug verlässt Hamburg um 14:35 Uhr und erreicht München um 18:10 Uhr. Unterwegs steht er insgesamt 25 Minuten still. Wie viele Minuten war er tatsächlich in Bewegung? ${FORMAT}`,
    assert: [{ type: 'answer', value: '190' }],
  },
  {
    name: 'Stufe 3 · Code nachvollziehen',
    difficulty: 3,
    prompt: `Was gibt dieses Python-Programm aus?\n\n\`\`\`python\n${PYTHON_FIB}\n\`\`\`\n\n${FORMAT}`,
    assert: [{ type: 'answer', value: '88' }],
  },
  {
    name: 'Stufe 4 · Wahrscheinlichkeit',
    difficulty: 4,
    prompt: `Eine Urne enthält 5 rote und 3 blaue Kugeln. Es werden nacheinander und ohne Zurücklegen 3 Kugeln gezogen. Wie groß ist die Wahrscheinlichkeit, dass genau 2 der gezogenen Kugeln rot sind? Gib das Ergebnis als vollständig gekürzten Bruch an. ${FORMAT}`,
    assert: [{ type: 'answer', value: '15/28' }],
  },
  {
    name: 'Stufe 5 · Kombinatorik mit Nebenbedingung',
    difficulty: 5,
    prompt: `Auf wie viele verschiedene Arten lassen sich die Buchstaben des Wortes MISSISSIPPI anordnen, sodass keine zwei gleichen Buchstaben direkt nebeneinander stehen? Gleiche Buchstaben sind nicht unterscheidbar. ${FORMAT}`,
    assert: [{ type: 'answer', value: '2016' }],
  },
];

// Führt einen Testdatensatz gegen ein Modell aus. Der Score gewichtet die Fälle nach ihrer Schwierigkeit.
export async function runCases(ctx, model, cases, llm = ctx.llm()) {
  const results = [];
  for (const testCase of cases) {
    if (ctx.signal.aborted) break;
    const base = { name: testCase.name ?? testCase.prompt?.slice(0, 60), difficulty: testCase.difficulty ?? 1 };
    try {
      const res = await llm.chat({
        model,
        temperature: testCase.temperature ?? ctx.config.temperature ?? 0,
        max_tokens: testCase.maxTokens ?? ctx.config.maxTokens,
        messages: buildMessages(testCase),
      });
      const verdict = await checkAll(testCase.assert, res.content, ctx);
      results.push({
        ...base,
        ok: verdict.ok,
        outcomes: verdict.outcomes,
        latencyMs: Math.round(res.latencyMs),
        tokens: res.usage?.total_tokens ?? null,
        answer: res.content.slice(-600),
      });
    } catch (err) {
      results.push({ ...base, ok: false, error: err.message });
    }
  }
  const weight = (r) => r.difficulty;
  const total = results.reduce((n, r) => n + weight(r), 0);
  const earned = results.filter((r) => r.ok).reduce((n, r) => n + weight(r), 0);
  return {
    results,
    score: total ? earned / total : 0,
    latencyAvg: avg(results.filter((r) => r.latencyMs).map((r) => r.latencyMs)),
  };
}

export default {
  type: 'quality',
  label: 'Qualität',
  description:
    'Fünf Fragen von leicht bis extrem schwer (Logik, Rechnen, Code, Wahrscheinlichkeit, Kombinatorik). Score = nach Schwierigkeit gewichteter Anteil richtiger Antworten.',
  defaults: {
    model: '',
    minScore: 0.6,
    maxTokens: 4096,
    judgeModel: '',
    cases: QUALITY_CASES,
  },
  async run(ctx) {
    const model = ctx.model();
    ctx.log('info', `${ctx.config.cases.length} Fälle gegen ${model}`);
    const { results, score, latencyAvg } = await runCases(ctx, model, ctx.config.cases);
    for (const r of results.filter((x) => !x.ok)) ctx.log('warn', `Fall nicht bestanden: ${r.name}`, r);
    const solved = results.filter((r) => r.ok).map((r) => r.difficulty);
    return {
      status: score >= ctx.config.minScore ? 'passed' : 'failed',
      model,
      score,
      metrics: {
        cases: results.length,
        passed: results.filter((r) => r.ok).length,
        highest_level: solved.length ? Math.max(...solved) : 0,
        latency_ms_avg: latencyAvg,
      },
      details: { cases: results },
    };
  },
};
