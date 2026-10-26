// Läufe anlegen: Prüfung (Audit), Nachtest eines Findings und Entwurfslauf einer Vorlage. Hier gelten Kill-Switch, Freigaben und Lastgrenzen.
import { many, one, tx } from './db.js';
import { enqueueRun } from './queue.js';
import { buildPlan, validateModels } from './plan.js';

export const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Zeitlich gültige, freigegebene Freigabe für die Prüfung (Vier-Augen-Prinzip wurde bei der Entscheidung geprüft).
export async function validApproval(auditId, client = null) {
  const sql = `select * from approvals where audit_id = $1 and status = 'approved'
     and (window_from is null or window_from <= now()) and (window_to is null or window_to >= now()) and runs_used < runs_allowed
     order by decided_at desc limit 1`;
  if (client) return (await client.query(sql, [auditId])).rows[0] ?? null;
  return one(sql, [auditId]);
}

// Die engeren Grenzen aus Prüfung und Freigabe gelten.
export function effectiveLimits(...limitSets) {
  const out = {};
  for (const l of limitSets) {
    for (const k of ['max_concurrency', 'max_duration_s']) {
      const v = Number(l?.[k]);
      if (v > 0) out[k] = out[k] ? Math.min(out[k], v) : v;
    }
  }
  return out;
}

// Was ein Start dieser Prüfung braucht: Freigabe für Prod-Ziele und Lasttests.
export function approvalNeeds(platform, plan) {
  const reasons = [];
  if (platform.environment === 'prod') reasons.push('Prod-Plattform');
  if (plan.some((a) => a.load && a.applicable)) reasons.push('Lasttest');
  return reasons;
}

async function insertRun(client, { kind, trigger, label, audit, platform, user, plan, apiKeyId, scheduleId, isDraft, approvalId, templateVersionId }) {
  const { rows } = await client.query(
    `insert into runs (kind, trigger, label, audit_id, platform_id, tenant_id, user_id, api_key_id, schedule_id, plan, total, repeats, is_draft, approval_id, gate, template_version_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
    [
      kind,
      trigger,
      label,
      audit?.id ?? null,
      platform.id,
      platform.tenant_id,
      user?.id ?? null,
      apiKeyId ?? null,
      scheduleId ?? null,
      JSON.stringify(plan),
      plan.length,
      audit?.repeats ?? 1,
      Boolean(isDraft),
      approvalId ?? null,
      audit ? JSON.stringify(audit.gate ?? {}) : null,
      templateVersionId ?? null,
    ],
  );
  return rows[0];
}

// Lauf einer Prüfung. `filter` schränkt für Nachtests auf Vorlage, Modell und Pfad ein.
export async function createAuditRun({ audit, user, trigger = 'manual', kind = 'audit', scheduleId = null, apiKeyId = null, label = null, filter = null }) {
  if (!audit.platform_id) throw err('Der Prüfung ist keine Plattform zugeordnet');
  const platform = await one('select * from platforms where id = $1', [audit.platform_id]);
  if (!platform) throw err('Plattform nicht gefunden');
  if (platform.locked) throw err(`Plattform „${platform.name}“ ist gesperrt (Kill-Switch)${platform.locked_reason ? `: ${platform.locked_reason}` : ''}`, 423);

  const approval = await validApproval(audit.id);
  const limits = effectiveLimits(audit.load_limits, approval?.limits);
  let plan = await buildPlan({ platformId: platform.id, models: audit.models, items: audit.items, repeats: audit.repeats, mode: audit.mode, compare: audit.compare, limits });
  if (filter) {
    plan = plan.filter((a) => (!filter.template_key || a.template_key === filter.template_key) && (!filter.model || a.model === filter.model) && (!filter.path || a.path === filter.path));
    plan = plan.map((a, idx) => ({ ...a, idx }));
  }
  for (const a of plan) if (!a.api_key_id && a.path !== 'direct') a.api_key_id = audit.api_key_id ?? null;
  if (!plan.some((a) => a.applicable)) throw err('Kein Einzeltest anwendbar: Modelle, Pfade oder Voraussetzungen der Vorlagen passen nicht zur Plattform');

  const needs = approvalNeeds(platform, plan);
  if (needs.length && !approval) throw err(`Freigabe erforderlich (${needs.join(', ')}): Bitte eine Freigabe beantragen`, 409);

  return tx(async (client) => {
    let approvalId = null;
    if (needs.length) {
      const { rows } = await client.query('update approvals set runs_used = runs_used + 1 where id = $1 and runs_used < runs_allowed returning id', [approval.id]);
      if (!rows[0]) throw err('Die Freigabe ist verbraucht', 409);
      approvalId = rows[0].id;
    }
    const run = await insertRun(client, {
      kind,
      trigger,
      label: label ?? (kind === 'retest' ? `Nachtest: ${audit.name}` : audit.name),
      audit,
      platform,
      user,
      plan,
      apiKeyId,
      scheduleId,
      approvalId,
    });
    await enqueueRun(run.id);
    return run;
  });
}

// Testlauf einer Vorlagenversion (auch Entwurf) ohne Prüfung. Zählt nicht in Historie und Dashboard; Prod nur mit Berechtigung.
export async function createDraftRun({ user, templateVersionId, platformId, models, thresholds = [], repeats = 1 }) {
  const platform = await one('select * from platforms where id = $1 and tenant_id = $2', [platformId, user.tenant_id]);
  if (!platform) throw err('Plattform nicht gefunden', 404);
  if (platform.locked) throw err(`Plattform „${platform.name}“ ist gesperrt (Kill-Switch)`, 423);
  if (platform.environment === 'prod' && !user.permissions.includes('runs.prod')) throw err('Testläufe von Vorlagen sind nur auf Dev-Plattformen erlaubt', 403);
  const selection = validateModels(models ?? []);
  const plan = await buildPlan({ platformId, models: selection, items: [{ template_version_id: templateVersionId, thresholds }], repeats, limits: { max_concurrency: 10, max_duration_s: 60 } });
  if (!plan.some((a) => a.applicable)) throw err('Kein Einzeltest anwendbar: Modell, Pfad oder Voraussetzungen passen nicht zur Plattform');
  const label = `Testlauf Vorlage: ${plan[0].template_name} ${plan[0].template_version}`;
  return tx(async (client) => {
    const run = await insertRun(client, { kind: 'draft', trigger: 'manual', label, audit: null, platform, user, plan, isDraft: true, templateVersionId });
    await enqueueRun(run.id);
    return run;
  });
}

export async function listRunIdsOfAudit(auditId) {
  return many('select id from runs where audit_id = $1', [auditId]);
}
