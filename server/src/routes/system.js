// Administration (global): Audit-Log und Systemeinstellungen wie die Aufbewahrungsfristen für Nachweise.
import { logAudit } from '../audit.js';
import { requirePermission } from '../auth.js';
import { DEFAULT_RETENTION, getRetention } from '../findings.js';
import { many, query } from '../db.js';
import { SENSITIVITIES } from '../datasets.js';

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export default async function systemRoutes(app) {
  app.get('/api/audit-log', { preHandler: requirePermission('audit.view') }, async (request) => {
    const q = request.query;
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(Math.max(Number(q.pageSize ?? 50), 1), 200);
    const params = [q.tenant_id || null, q.action ? `${q.action}%` : null, q.q ? `%${q.q}%` : null];
    const where = `($1::uuid is null or l.tenant_id = $1) and ($2::text is null or l.action like $2) and ($3::text is null or l.action ilike $3 or l.user_name ilike $3 or l.object_id ilike $3 or l.details::text ilike $3)`;
    const [{ total }] = await many(`select count(*)::int as total from audit_log l where ${where}`, params);
    const rows = await many(`select l.*, t.name as tenant_name from audit_log l left join tenants t on t.id = l.tenant_id where ${where} order by l.ts desc limit ${pageSize} offset ${(page - 1) * pageSize}`, params);
    return { total, page, pageSize, rows };
  });

  app.get('/api/settings/retention', { preHandler: requirePermission('suite.view') }, async () => ({ days: await getRetention(), defaults: DEFAULT_RETENTION }));

  app.put('/api/settings/retention', { preHandler: requirePermission('settings.manage') }, async (request) => {
    const days = {};
    for (const s of SENSITIVITIES) {
      const v = Number(request.body?.days?.[s]);
      if (!Number.isInteger(v) || v < 1 || v > 3650) throw err(`Aufbewahrung für „${s}“: 1 bis 3650 Tage`);
      days[s] = v;
    }
    await query(`insert into app_settings (key, value, updated_by) values ('retention', $1, $2) on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`, [JSON.stringify(days), request.user.id]);
    await logAudit(request, 'settings.retention', 'settings', 'retention', days);
    return { days };
  });
}
