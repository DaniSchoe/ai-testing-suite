// Sichtbarkeit von API-Keys, Endpoints und Modellen für einen User.
const teamIdsOf = (user) => (user.teams ?? []).map((t) => t.id);
const overlaps = (user, teamIds = []) => teamIdsOf(user).some((id) => teamIds.includes(id));

// Endpoint bzw. Modell mit visibility admins | teams | global. Maintainer sehen ihre Objekte immer.
export function canSeePublished(user, { visibility, teamIds, maintainer_id }) {
  if (user.is_admin) return true;
  if (maintainer_id && maintainer_id === user.id) return true;
  if (visibility === 'global') return true;
  if (visibility === 'teams') return overlaps(user, teamIds);
  return false;
}

// API-Key: Admins sehen alle. Sonst nie admin_only; sichtbar für Ersteller, ausdrücklich zugeordnete User,
// Mitglieder zugeordneter Teams oder alle bei global.
export function canSeeKey(user, key) {
  if (user.is_admin) return true;
  if (key.admin_only) return false;
  if (key.created_by === user.id) return true;
  if ((key.userIds ?? []).includes(user.id)) return true;
  if (key.visibility === 'global') return true;
  if (key.visibility === 'teams') return overlaps(user, key.teamIds);
  return false;
}

export function canEditKey(user, key) {
  return user.is_admin || key.created_by === user.id;
}
