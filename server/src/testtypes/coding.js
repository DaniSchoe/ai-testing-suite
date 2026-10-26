import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { avg } from '../runner/clients.js';

const RUNNER = fileURLToPath(new URL('./sandbox-runner.mjs', import.meta.url));
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

const ONLY_CODE =
  'Antworte ausschließlich mit einem JavaScript-Codeblock (```js). Keine Erklärung, keine Beispielaufrufe, kein require/import/export.';

// Zwei Aufgaben: eine einfache und eine komplexe. Die Tests sind Ausdrücke, die gegen den Code des Modells laufen.
export const CODING_TASKS = [
  {
    name: 'Einfach · Palindrom-Prüfung',
    weight: 1,
    prompt: `Schreibe eine JavaScript-Funktion isPalindrome(text), die true zurückgibt, wenn text ein Palindrom ist, und sonst false. Groß- und Kleinschreibung sowie alle Zeichen außer Buchstaben (a-z) und Ziffern werden ignoriert. ${ONLY_CODE}`,
    tests: [
      { expr: "isPalindrome('A man, a plan, a canal: Panama')", expect: true },
      { expr: "isPalindrome('Hello')", expect: false },
      { expr: "isPalindrome('')", expect: true },
      { expr: "isPalindrome('Was it a car or a cat I saw?')", expect: true },
      { expr: "isPalindrome('No lemon, no melon')", expect: true },
      { expr: "isPalindrome('12321')", expect: true },
      { expr: "isPalindrome('12 3 4')", expect: false },
      { expr: "isPalindrome('Ab')", expect: false },
    ],
  },
  {
    name: 'Komplex · Rechenausdrücke auswerten',
    weight: 2,
    forbid: '\\beval\\s*\\(|new\\s+Function|\\bFunction\\s*\\(',
    prompt: `Schreibe eine JavaScript-Funktion evaluate(expression), die einen arithmetischen Ausdruck als String auswertet und die Zahl zurückgibt. Unterstützt werden die Operatoren + - * /, Klammern, Dezimalzahlen mit Punkt, beliebige Leerzeichen und das unäre Minus (z. B. "-(2 + 3)" und "2 * -3"). Es gilt Punkt-vor-Strich, gleichrangige Operatoren werden von links nach rechts ausgewertet. Eval und new Function sind verboten, schreibe einen eigenen Parser. Bei einer Division durch 0 und bei jedem ungültigen Ausdruck (z. B. "2 +", "(1 + 2", "3 $ 4") wird ein Error geworfen. ${ONLY_CODE}`,
    tests: [
      { expr: "evaluate('1 + 2 * 3')", expect: 7 },
      { expr: "evaluate('(1 + 2) * 3')", expect: 9 },
      { expr: "evaluate('10 / 4')", expect: 2.5 },
      { expr: "evaluate('2 * (3 + 4) * 5')", expect: 70 },
      { expr: "evaluate('-3 + 5')", expect: 2 },
      { expr: "evaluate('-(2 + 3) * 2')", expect: -10 },
      { expr: "evaluate('2 - 3 - 4')", expect: -5 },
      { expr: "evaluate('8 / 2 / 2')", expect: 2 },
      { expr: "evaluate('1.5 * 4')", expect: 6 },
      { expr: "evaluate('2 * -3')", expect: -6 },
      { expr: "evaluate('((2))')", expect: 2 },
      { expr: "evaluate('  7 -  2 * ( 1 + 1 ) ')", expect: 3 },
      { expr: "evaluate('1 / 0')", throws: true },
      { expr: "evaluate('2 +')", throws: true },
      { expr: "evaluate('(1 + 2')", throws: true },
      { expr: "evaluate('3 $ 4')", throws: true },
    ],
  },
];

// Code aus der Antwort holen: der längste Codeblock, sonst die ganze Antwort. Modul-Syntax wird entschärft.
export function extractCode(answer) {
  const blocks = [...answer.matchAll(/```(?:js|javascript|node)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  const code = blocks.length ? blocks.sort((a, b) => b.length - a.length)[0] : answer;
  return code
    .replace(/^\s*module\.exports\s*=.*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+/gm, '')
    .replace(/^\s*(?:const|let|var)\s+\w+\s*=\s*require\(.*$/gm, '');
}

// Code samt Tests in einem isolierten Prozess ausführen (siehe sandbox-runner.mjs).
export function runSandboxed({ code, tests, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [PERMISSION_FLAG, `--allow-fs-read=${RUNNER}`, '--max-old-space-size=128', RUNNER],
      { timeout: timeoutMs, maxBuffer: 1_000_000, env: {}, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Sandbox fehlgeschlagen: ${(stderr || err.message).split('\n')[0]}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Sandbox lieferte keine gültige Ausgabe'));
        }
      },
    );
    child.stdin.end(JSON.stringify({ code, tests }));
  });
}

export default {
  type: 'coding',
  label: 'Coding',
  description:
    'Das Modell löst eine einfache und eine komplexe Programmieraufgabe (JavaScript). Der Code läuft isoliert gegen vorbereitete Tests; Score = Anteil bestandener Tests, die komplexe Aufgabe zählt doppelt.',
  defaults: { model: '', minScore: 0.7, maxTokens: 4096, tasks: [] },
  async run(ctx) {
    const model = ctx.model();
    const llm = ctx.llm();
    const tasks = [];
    if (!ctx.config.tasks?.length) throw new Error('Kein Datensatz zugeordnet');
    for (const task of ctx.config.tasks) {
      if (ctx.signal.aborted) break;
      try {
        const res = await llm.chat({
          model,
          temperature: ctx.config.temperature ?? 0,
          max_tokens: ctx.config.maxTokens,
          messages: [{ role: 'user', content: task.prompt }],
        });
        const code = extractCode(res.content);
        const forbidden = task.forbid && new RegExp(task.forbid).test(code);
        const outcomes = forbidden
          ? task.tests.map((t) => ({ name: t.expr, ok: false, error: 'Verbotene Funktion (eval/new Function) verwendet' }))
          : await runSandboxed({ code, tests: task.tests.map((t) => ({ ...t, name: t.expr })) });
        const passed = outcomes.filter((o) => o.ok).length;
        tasks.push({
          name: task.name,
          weight: task.weight ?? 1,
          ok: passed === outcomes.length,
          passed,
          tests: outcomes.length,
          score: outcomes.length ? passed / outcomes.length : 0,
          latencyMs: Math.round(res.latencyMs),
          prompt: task.prompt,
          failures: outcomes.filter((o) => !o.ok).slice(0, 5),
          code: code.slice(0, 4000),
        });
        if (passed !== outcomes.length) ctx.log('warn', `${task.name}: ${passed}/${outcomes.length} Tests bestanden`);
      } catch (err) {
        tasks.push({ name: task.name, weight: task.weight ?? 1, ok: false, passed: 0, tests: task.tests.length, score: 0, error: err.message });
      }
    }
    const weight = tasks.reduce((n, t) => n + t.weight, 0);
    const score = weight ? tasks.reduce((n, t) => n + t.weight * t.score, 0) / weight : 0;
    return {
      status: score >= ctx.config.minScore ? 'passed' : 'failed',
      model,
      score,
      metrics: {
        cases: tasks.length,
        passed: tasks.filter((t) => t.ok).length,
        tests_passed: tasks.reduce((n, t) => n + t.passed, 0),
        tests_total: tasks.reduce((n, t) => n + t.tests, 0),
        latency_ms_avg: avg(tasks.filter((t) => t.latencyMs).map((t) => t.latencyMs)),
      },
      // "cases" für die Tabelle in der Detailansicht; failures und Code stehen im Roh-JSON.
      details: {
        cases: tasks.map((t) => ({
          name: t.name,
          ok: t.ok,
          error: t.error,
          prompt: t.prompt,
          response: t.code,
          notes: [`${t.passed}/${t.tests} Tests`, ...(t.failures ?? []).map((f) => `${f.name}: ${f.error ?? `erhielt ${JSON.stringify(f.got)}`}`)],
        })),
        tasks,
      },
    };
  },
};
