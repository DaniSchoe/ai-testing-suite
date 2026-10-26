// Nachweise (Evidence mit Hash und Aufbewahrungsfrist) und Findings, die aus fehlgeschlagenen Sicherheits-, Zugriffs- und Plattformtests entstehen.
import { createHash } from 'node:crypto';
import { many, one, query } from './db.js';

export const OWASP = 'OWASP LLM Top 10';
// Zuordnung der Fallkategorien der Angriffsdatensätze zu OWASP LLM Top 10.
export const OWASP_OF_CATEGORY = { prompt_injection: 'LLM01', jailbreak: 'LLM01', harmful: 'LLM01', dlp_input: 'LLM02', dlp_output: 'LLM02', access: 'LLM06', excessive_agency: 'LLM06' };
const SEVERITY_OF_CATEGORY = { prompt_injection: 'high', jailbreak: 'high', harmful: 'critical', dlp_input: 'high', dlp_output: 'medium' };
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const FINDING_STATUS = ['open', 'in_progress', 'accepted', 'fixed', 'closed'];

export const DEFAULT_RETENTION = { public: 365, internal: 180, customer: 90, attack: 30 };

const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
export const sha256 = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
export const evidenceHash = ({ prompt, response, assessment }) => sha256({ prompt: prompt ?? null, response: response ?? null, assessment: assessment ?? null });

export async function getRetention() {
  const row = await one(`select value from app_settings where key = 'retention'`);
  return { ...DEFAULT_RETENTION, ...(row?.value ?? {}) };
}

// Einzelfälle eines Ergebnisses als Nachweise speichern. Der Hash deckt Prompt, Antwort und Bewertung ab und bleibt nach der Löschung des Inhalts erhalten.
export async function storeEvidence({ tenantId, runId, resultId, details, sensitivity, retention }) {
  const cases = Array.isArray(details?.cases) ? details.cases.slice(0, 300) : [];
  const days = retention[sensitivity] ?? retention.internal;
  const hashes = [];
  for (const c of cases) {
    const { prompt, response, answer, name, ...rest } = c;
    const ev = {
      prompt: prompt ?? (c.target ? `${c.apiKey ?? 'anonym'} → ${c.target}` : null),
      response: response ?? answer ?? (c.status !== undefined ? `HTTP ${c.status}` : null),
      assessment: { ok: c.ok ?? null, ...rest },
    };
    const hash = evidenceHash(ev);
    hashes.push(hash);
    await query(
      `insert into evidence (tenant_id, run_id, result_id, case_key, prompt, response, assessment, ok, hash, sensitivity, retain_until)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(days => $11::int))`,
      [tenantId, runId, resultId, name ?? c.case_key ?? 'Fall', ev.prompt, ev.response, JSON.stringify(ev.assessment), c.ok ?? null, hash, sensitivity, days],
    );
  }
  return hashes;
}

// Kette über alle Nachweise eines Laufs: ändert sich ein Inhalt oder fehlt ein Eintrag, stimmt der Lauf-Hash nicht mehr.
export async function sealRun(runId) {
  const rows = await many('select hash from evidence where run_id = $1 order by created_at, id', [runId]);
  const hash = rows.length ? sha256(rows.map((r) => r.hash).join('\n')) : null;
  await query('update runs set evidence_hash = $2 where id = $1', [runId, hash]);
  return hash;
}

export async function verifyRun(runId) {
  const rows = await many('select id, case_key, prompt, response, assessment, hash, purged_at from evidence where run_id = $1 order by created_at, id', [runId]);
  const run = await one('select evidence_hash from runs where id = $1', [runId]);
  const items = rows.map((r) => ({
    id: r.id,
    case_key: r.case_key,
    purged: Boolean(r.purged_at),
    // Gelöschter Inhalt lässt sich nicht mehr prüfen; der gespeicherte Hash bleibt Teil der Kette.
    valid: r.purged_at ? null : evidenceHash(r) === r.hash,
  }));
  const chain = rows.length ? sha256(rows.map((r) => r.hash).join('\n')) : null;
  return { ok: items.every((i) => i.valid !== false) && chain === run?.evidence_hash, chain_ok: chain === run?.evidence_hash, items };
}

// Abgelaufene Inhalte löschen; Hash und Metadaten bleiben.
export async function purgeEvidence() {
  const res = await query(
    `update evidence set prompt = null, response = null, assessment = null, purged_at = now()
     where purged_at is null and retain_until is not null and retain_until < now()`,
  );
  return res.rowCount;
}

function categoryOf(atom, c) {
  const owasp = OWASP_OF_CATEGORY[c?.category] ?? atom.categories?.find((x) => x.framework === OWASP)?.key;
  if (owasp) return { framework: OWASP, category: owasp };
  const first = atom.categories?.[0];
  return first ? { framework: first.framework, category: first.key } : { framework: null, category: c?.category ?? null };
}

function severityOf(atom, c) {
  if (c?.severity && SEVERITIES.includes(c.severity)) return c.severity;
  if (atom.type === 'access') return c.expect === 'deny' ? 'critical' : 'low';
  if (atom.type === 'mcp') return 'high';
  if (atom.type === 'smoke') return 'medium';
  return SEVERITY_OF_CATEGORY[c?.category] ?? 'medium';
}

// Findings aus einem fehlgeschlagenen Ergebnis anlegen oder fortschreiben. Gibt die Fingerprints der festgestellten Probleme zurück.
export async function recordFindings({ tenantId, run, atom, details, outcome }) {
  const found = [];
  const security = atom.security || ['security', 'access', 'mcp'].includes(atom.type);
  const platformFailure = atom.type === 'smoke' && outcome === 'quality_deviation';
  if (!security && !platformFailure) return found;
  if (outcome === 'technical_error' || outcome === 'not_applicable') return found;
  const cases = Array.isArray(details?.cases) ? details.cases.filter((c) => c.ok === false && !c.error) : [];
  if (outcome === 'passed' && !cases.length) return found;
  const items = cases.length
    ? cases.map((c) => ({ c, name: c.name ?? 'Fall' }))
    : [{ c: {}, name: atom.type === 'smoke' ? (atom.endpoint_name ?? 'Erreichbarkeit') : atom.template_name }];
  for (const { c, name } of items) {
    const fingerprint = sha256([atom.platform_id ?? run.platform_id ?? '', atom.template_key, name, atom.model ?? '', atom.path ?? ''].join('|'));
    const { framework, category } = categoryOf(atom, c);
    const evidence = {
      prompt: c.prompt ?? null,
      response: c.response ?? c.answer ?? null,
      assessment: { expect: c.expect, blocked: c.blocked, leakedCanary: c.leakedCanary, pii: c.pii, status: c.status },
    };
    evidence.hash = evidenceHash(evidence);
    const title = cases.length ? `${atom.template_name}: ${name}` : `${atom.template_name} fehlgeschlagen${atom.endpoint_name ? ` (${atom.endpoint_name})` : ''}`;
    const existing = await one('select id, status from findings where tenant_id = $1 and fingerprint = $2', [tenantId, fingerprint]);
    if (existing) {
      const reopen = ['fixed', 'closed'].includes(existing.status);
      await query(
        `update findings set occurrences = occurrences + 1, last_seen_at = now(), last_run_id = $2, evidence = $3, updated_at = now(), audit_id = coalesce($5, audit_id),
           status = case when $4 then 'open' else status end where id = $1`,
        [existing.id, run.id, JSON.stringify(evidence), reopen, run.audit_id ?? null],
      );
      if (reopen) await query(`insert into finding_events (finding_id, kind, data) values ($1, 'reopened', $2)`, [existing.id, JSON.stringify({ run_id: run.id })]);
    } else {
      const row = await one(
        `insert into findings (tenant_id, platform_id, audit_id, fingerprint, title, description, severity, framework, category, template_key, case_name, model, path, evidence, first_run_id, last_run_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) returning id`,
        [
          tenantId,
          run.platform_id,
          run.audit_id,
          fingerprint,
          title,
          cases.length ? `Fall „${name}“ ist bei ${atom.model ?? atom.endpoint_name ?? 'der Komponente'}${atom.path ? ` (${atom.path === 'direct' ? 'direkt' : 'über das Gateway'})` : ''} fehlgeschlagen.` : `Der Test „${atom.template_name}“ ist fehlgeschlagen.`,
          severityOf(atom, c),
          framework,
          category,
          atom.template_key,
          cases.length ? name : null,
          atom.model ?? null,
          atom.path ?? null,
          JSON.stringify(evidence),
          run.id,
        ],
      );
      await query(`insert into finding_events (finding_id, kind, data) values ($1, 'created', $2)`, [row.id, JSON.stringify({ run_id: run.id, automatic: true })]);
    }
    found.push(fingerprint);
  }
  return found;
}

// Nachtest: Findings, deren Retest-Lauf beendet ist, als behoben oder weiterhin bestehend markieren.
export async function finalizeRetests(run, failedFingerprints) {
  const rows = await many('select id, fingerprint, status from findings where retest_run_id = $1', [run.id]);
  for (const f of rows) {
    const still = failedFingerprints.has(f.fingerprint);
    await query(
      `update findings set retest_result = $2, status = case when $2 = 'fixed' then 'fixed' else 'open' end, updated_at = now() where id = $1`,
      [f.id, still ? 'still_failing' : 'fixed'],
    );
    await query(`insert into finding_events (finding_id, kind, data) values ($1, 'retest', $2)`, [f.id, JSON.stringify({ run_id: run.id, result: still ? 'still_failing' : 'fixed' })]);
  }
}
