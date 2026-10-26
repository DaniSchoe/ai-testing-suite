// Führt von einem Modell erzeugten JavaScript-Code gegen Testausdrücke aus. Läuft als eigener Prozess mit dem
// Node-Berechtigungsmodell (kein Dateisystem, keine Kindprozesse, leere Umgebung) und in einem leeren vm-Kontext
// ohne require, process oder fetch. Eingabe über stdin: { code, setup, tests: [{ name, expr, expect, throws }] }.
import vm from 'node:vm';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { code, setup, tests } = JSON.parse(input);

const sandbox = vm.createContext({ console: { log() {}, error() {}, warn() {}, info() {} } }, { codeGeneration: { strings: true, wasm: false } });
const out = [];
let loadError = null;
try {
  vm.runInContext(code, sandbox, { timeout: 2000 });
  if (setup) vm.runInContext(setup, sandbox, { timeout: 2000 });
} catch (err) {
  loadError = String(err?.message ?? err).slice(0, 300);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const t of tests) {
  if (loadError) {
    out.push({ name: t.name, ok: false, error: `Code nicht ausführbar: ${loadError}` });
    continue;
  }
  try {
    // JSON-Kopie im Kontext erzeugen, damit nur Daten und keine Objekte des Kontexts ins Ergebnis gelangen.
    const got = vm.runInContext(`JSON.stringify((() => (${t.expr}))())`, sandbox, { timeout: 1000 });
    const value = got === undefined ? undefined : JSON.parse(got);
    if (t.throws) out.push({ name: t.name, ok: false, error: 'wirft keinen Fehler', got: value });
    else out.push({ name: t.name, ok: same(value, t.expect), got: value, expect: t.expect });
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 200);
    out.push(t.throws ? { name: t.name, ok: true } : { name: t.name, ok: false, error: message });
  }
}
process.stdout.write(JSON.stringify(out));
