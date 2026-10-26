// Prüfbericht je Lauf: Management Summary, Bewertungen, Findings, Frameworkbezug und Plattform-Snapshot.
// Die KI-Analyse ist nur ein Entwurf; freigegeben wird der Bericht von einem Reviewer.
import { many, one } from './db.js';

const OUTCOME_LABEL = { passed: 'bestanden', quality_deviation: 'Qualitätsabweichung', security_finding: 'Sicherheitsfinding', technical_error: 'technischer Fehler', not_applicable: 'nicht anwendbar' };
export const outcomeLabel = (o) => OUTCOME_LABEL[o] ?? o ?? '–';

export function rating(outcomes = {}) {
  if (outcomes.security_finding || outcomes.technical_error) return { key: 'failed', label: 'Nicht bestanden' };
  if (outcomes.quality_deviation) return { key: 'conditional', label: 'Bedingt bestanden' };
  return { key: 'passed', label: 'Bestanden' };
}

export async function buildReportBody(runId) {
  const run = await one('select r.*, a.name as audit_name, p.name as platform_name, p.environment, p.sovereignty from runs r left join audits a on a.id = r.audit_id left join platforms p on p.id = r.platform_id where r.id = $1', [runId]);
  const results = await many(
    `select id, test_name, type, template_key, template_version, model_alias, path, variant, endpoint_name, status, outcome, score, metrics, statistics, details, sensitivity, attempts, item_index
     from results where run_id = $1 order by item_index, started_at`,
    [runId],
  );
  const templates = await many(
    `select distinct on (t.key) t.key, t.name, coalesce((select jsonb_agg(jsonb_build_object('framework', c.framework, 'key', c.key, 'name', c.name)) from template_version_categories tc join categories c on c.id = tc.category_id where tc.version_id = (select id from template_versions where template_id = t.id order by string_to_array(version, '.')::int[] desc limit 1)), '[]') as categories from templates t`,
  );
  const catsOf = new Map(templates.map((t) => [t.key, t.categories]));
  const findings = await many(
    `select id, title, severity, status, framework, category, model, path, case_name from findings where first_run_id = $1 or last_run_id = $1 order by array_position(array['critical','high','medium','low','info'], severity)`,
    [runId],
  );
  const mapping = {};
  for (const r of results) {
    if (r.outcome === 'not_applicable') continue;
    for (const c of catsOf.get(r.template_key) ?? []) {
      const k = `${c.framework} · ${c.key} ${c.name}`;
      mapping[k] ??= { framework: c.framework, key: c.key, name: c.name, passed: 0, failed: 0 };
      mapping[k][r.status === 'passed' ? 'passed' : 'failed'] += 1;
    }
  }
  const regressions = results.filter((r) => r.details?.regression?.regressions?.length).length;
  return {
    run: { id: run.id, label: run.label, status: run.status, kind: run.kind, created_at: run.created_at, started_at: run.started_at, finished_at: run.finished_at },
    audit: run.audit_id ? { id: run.audit_id, name: run.audit_name } : null,
    platform: run.platform_id ? { id: run.platform_id, name: run.platform_name, environment: run.environment } : null,
    rating: rating(run.outcomes),
    outcomes: run.outcomes,
    ratings: results.map((r) => ({
      name: r.test_name,
      template: r.template_key,
      version: r.template_version,
      type: r.type,
      model: r.model_alias,
      path: r.path,
      variant: r.variant,
      endpoint: r.endpoint_name,
      status: r.status,
      outcome: r.outcome,
      score: r.score === null ? null : Number(r.score),
      metrics: r.metrics,
      violations: r.details?.thresholds?.violations ?? [],
      reason: r.details?.reason ?? null,
      statistics: r.statistics,
      small_sample: Boolean(r.statistics?.small_sample),
      regression: r.details?.regression?.regressions ?? [],
    })),
    findings,
    framework_mapping: Object.values(mapping).sort((a, b) => a.framework.localeCompare(b.framework) || a.key.localeCompare(b.key, 'de', { numeric: true })),
    snapshot: run.snapshot,
    comparison: run.comparison,
    regressions,
    sovereignty: run.sovereignty,
    evidence_hash: run.evidence_hash,
  };
}

// Bericht anlegen oder (solange Entwurf) aktualisieren.
export async function ensureReport(runId) {
  const run = await one('select id, tenant_id, audit_id, user_id, analysis from runs where id = $1', [runId]);
  if (!run?.audit_id) return null;
  const body = await buildReportBody(runId);
  const draft = run.analysis?.text ?? null;
  const existing = await one('select id, status from reports where run_id = $1', [runId]);
  if (!existing) {
    return one(
      `insert into reports (tenant_id, audit_id, run_id, summary, ai_draft, body, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [run.tenant_id, run.audit_id, runId, defaultSummary(body), draft, JSON.stringify(body), run.user_id],
    );
  }
  if (existing.status !== 'draft') return existing;
  return one('update reports set body = $2, ai_draft = $3, updated_at = now() where id = $1 returning *', [existing.id, JSON.stringify(body), draft]);
}

// Sachliche Grundfassung der Management Summary aus den Messdaten (kein KI-Text).
export function defaultSummary(body) {
  const o = body.outcomes ?? {};
  const parts = [`${body.audit?.name ?? body.run.label} auf ${body.platform?.name ?? 'der Plattform'} (${body.platform?.environment ?? '–'}): ${body.rating.label}.`];
  const total = body.ratings.length;
  parts.push(`${total} Einzeltests, davon ${o.passed ?? 0} bestanden${o.quality_deviation ? `, ${o.quality_deviation} mit Qualitätsabweichung` : ''}${o.security_finding ? `, ${o.security_finding} mit Sicherheitsfinding` : ''}${o.technical_error ? `, ${o.technical_error} mit technischem Fehler` : ''}${o.not_applicable ? `, ${o.not_applicable} nicht anwendbar` : ''}.`);
  if (body.findings.length) parts.push(`${body.findings.length} Findings, davon ${body.findings.filter((f) => ['critical', 'high'].includes(f.severity)).length} kritisch oder hoch.`);
  return parts.join(' ');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function reportMarkdown(report) {
  const b = report.body;
  const lines = [`# Prüfbericht: ${b.audit?.name ?? b.run.label}`, '', `- Plattform: ${b.platform?.name ?? '–'} (${b.platform?.environment ?? '–'})`, `- Lauf: ${b.run.finished_at ?? b.run.created_at}`, `- Gesamtbewertung: **${b.rating.label}**`, `- Status des Berichts: ${report.status}${report.approved_at ? ` (freigegeben ${report.approved_at})` : ''}`, '', '## Management Summary', '', report.summary ?? '', ''];
  lines.push('## Bewertungen', '', '| Test | Modell | Pfad | Ergebnis | Score |', '|---|---|---|---|---|');
  for (const r of b.ratings) lines.push(`| ${r.name} | ${r.model ?? '–'} | ${r.path ?? '–'} | ${outcomeLabel(r.outcome)} | ${r.score === null ? '–' : Math.round(r.score * 100) / 100} |`);
  lines.push('', '## Findings', '');
  if (!b.findings.length) lines.push('Keine Findings.');
  for (const f of b.findings) lines.push(`- **${f.severity}** · ${f.title} (${f.status})${f.framework ? ` · ${f.framework} ${f.category}` : ''}`);
  lines.push('', '## Frameworkbezug', '', '| Kategorie | Bestanden | Nicht bestanden |', '|---|---|---|');
  for (const m of b.framework_mapping) lines.push(`| ${m.framework} ${m.key} ${m.name} | ${m.passed} | ${m.failed} |`);
  if (b.snapshot) {
    lines.push('', '## Plattform-Snapshot', '', ...b.snapshot.components.map((c) => `- ${c.name} (${c.kind}): ${c.version ?? 'Version unbekannt'}, ${c.status}`));
    for (const m of b.snapshot.models ?? []) lines.push(`- Modell ${m.alias}: Revision ${m.revision ?? '–'}, Quantisierung ${m.quantization ?? '–'}`);
  }
  if (b.evidence_hash) lines.push('', `Nachweis-Hash (SHA-256): \`${b.evidence_hash}\``);
  return lines.join('\n');
}

export function reportHtml(report) {
  const md = reportMarkdown(report);
  const body = md
    .split('\n')
    .map((l) => (l.startsWith('# ') ? `<h1>${esc(l.slice(2))}</h1>` : l.startsWith('## ') ? `<h2>${esc(l.slice(3))}</h2>` : l.startsWith('|---') ? '' : l.startsWith('|') ? `<tr>${l.split('|').slice(1, -1).map((c) => `<td>${esc(c.trim())}</td>`).join('')}</tr>` : l.startsWith('- ') ? `<li>${esc(l.slice(2)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>` : l ? `<p>${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>` : ''))
    .join('\n');
  return `<!doctype html><html lang="de"><meta charset="utf-8"><title>Prüfbericht</title><style>body{font:14px/1.5 system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse}td{border:1px solid #ccc;padding:4px 8px}</style><body>${body}</body></html>`;
}
