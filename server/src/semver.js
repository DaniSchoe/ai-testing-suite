// Semantische Versionen (x.y.z) für Vorlagen, Pakete und Datensätze.
const RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isSemver = (v) => RE.test(String(v ?? ''));

export function parse(v) {
  const m = RE.exec(String(v ?? ''));
  if (!m) throw Object.assign(new Error(`Ungültige Version "${v}" (erwartet x.y.z)`), { statusCode: 400 });
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function bump(v, kind = 'minor') {
  const [major, minor, patch] = parse(v);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Höchste Version aus einer Liste.
export const latest = (versions) => [...versions].sort(compare).at(-1) ?? null;
