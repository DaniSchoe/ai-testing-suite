// Audit-Log: wer hat wann was geändert (Freigaben, Rollen, Prod-Läufe, Katalog usw.).
import { query } from './db.js';

export async function logAudit(request, action, objectType = null, objectId = null, details = {}) {
  const user = request?.user;
  try {
    await query(
      `insert into audit_log (tenant_id, user_id, user_name, action, object_type, object_id, details)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [user?.tenant_id ?? null, user?.id ?? null, user?.display_name ?? user?.username ?? null, action, objectType, objectId ? String(objectId) : null, JSON.stringify(details ?? {})],
    );
  } catch (err) {
    request?.log?.warn?.(`Audit-Log: ${err.message}`);
  }
}
