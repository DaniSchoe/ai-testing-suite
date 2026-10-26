// Sichtbarkeit von Läufen und Ergebnissen: eigene, die eines Teams oder alle.
import { hasPermission } from './permissions.js';
import { one } from './db.js';

const forbidden = (message) => Object.assign(new Error(message), { statusCode: 403 });

// Aus ?scope=me|all|global|team&teamId=… den erlaubten Bereich ableiten.
// Ohne results.view_all sind nur eigene Läufe und die eigener Teams sichtbar.
export function resolveScope(user, { scope, teamId } = {}, fallback = 'me') {
  const wanted = scope ?? fallback;
  if (wanted === 'all' || wanted === 'global') {
    return hasPermission(user, 'results.view_all') ? { scope: 'all', teamId: null } : { scope: 'me', teamId: null };
  }
  if (wanted === 'team') {
    if (!teamId) throw Object.assign(new Error('teamId fehlt'), { statusCode: 400 });
    const member = user.teams?.some((t) => t.id === teamId);
    if (!member && !hasPermission(user, 'results.view_all')) throw forbidden('Kein Mitglied dieses Teams');
    return { scope: 'team', teamId };
  }
  return { scope: 'me', teamId: null };
}

// SQL-Bedingung für runs-Alias r; erwartet die Parameter scope, userId, teamId an den Positionen i, i+1, i+2.
export function scopeSql(i = 1, alias = 'r') {
  return `($${i} = 'all' or ($${i} = 'me' and ${alias}.user_id = $${i + 1})
    or ($${i} = 'team' and ${alias}.user_id in (select user_id from team_members where team_id = $${i + 2}::uuid)))`;
}

export const scopeParams = (user, s) => [s.scope, user.id, s.teamId];

// Einzelnen Lauf ansehen: eigener, mit results.view_all oder aus einem gemeinsamen Team.
export async function canSeeRunOf(user, ownerId) {
  if (!ownerId || ownerId === user.id || hasPermission(user, 'results.view_all')) return true;
  const shared = await one(
    `select 1 from team_members a join team_members b on a.team_id = b.team_id where a.user_id = $1 and b.user_id = $2 limit 1`,
    [user.id, ownerId],
  );
  return Boolean(shared);
}
