// Berechtigungen der Anwendung. Rollen bündeln Berechtigungen und werden in der App gepflegt.
export const PERMISSIONS = [
  { key: 'suite.view', label: 'Anwendung nutzen', description: 'Dashboard, Tests, Endpoints und eigene Ergebnisse ansehen' },
  { key: 'results.view_all', label: 'Alle Ergebnisse sehen', description: 'Globales Dashboard und Testausführungen aller User' },
  { key: 'tests.manage', label: 'Tests pflegen', description: 'Tests und Suiten anlegen, ändern und löschen' },
  { key: 'runs.start', label: 'Tests ausführen', description: 'Testläufe starten und eigene Läufe abbrechen' },
  { key: 'schedules.manage', label: 'Zeitpläne pflegen', description: 'Eigene Zeitpläne anlegen, ändern und löschen' },
  { key: 'runs.manage_all', label: 'Fremde Läufe verwalten', description: 'Läufe und Zeitpläne anderer User abbrechen, ändern und löschen' },
  { key: 'endpoints.manage', label: 'Endpoints verwalten', description: 'Endpoints anlegen, Modelle im Katalog bearbeiten (Administratoren)' },
  { key: 'users.manage', label: 'Benutzer verwalten', description: 'User anlegen, sperren und Rollen zuweisen' },
  { key: 'teams.manage', label: 'Teams verwalten', description: 'Teams anlegen und Mitglieder zuordnen' },
  { key: 'roles.manage', label: 'Rollen verwalten', description: 'Rollen anlegen und ihre Berechtigungen festlegen' },
];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Admin per Umgebungsvariable: nur mit von Keycloak bestätigter E-Mail.
export function isEnvAdmin(user, adminEmails) {
  return Boolean(user?.email && user.email_verified && adminEmails.includes(user.email.toLowerCase()));
}

// Effektive Berechtigungen: Admins (Rolle oder ADMIN_EMAILS) haben alle, sonst die Vereinigung der Rollen.
export function effectivePermissions({ rolePermissions = [], hasAdminRole = false, envAdmin = false }) {
  if (hasAdminRole || envAdmin) return [...PERMISSION_KEYS];
  return PERMISSION_KEYS.filter((k) => rolePermissions.includes(k));
}

export function hasPermission(user, permission) {
  return Boolean(user && !user.disabled && user.permissions?.includes(permission));
}
