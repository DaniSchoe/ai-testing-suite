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
  { key: 'roles.manage', label: 'Rollen verwalten', description: 'Rollen anlegen und ihre Berechtigungen festlegen (global)' },
  { key: 'catalog.publish', label: 'Katalog freigeben', description: 'Vorlagen und Pakete im Review prüfen und veröffentlichen (Vier-Augen-Prinzip)' },
  { key: 'security.payloads', label: 'Angriffs-Payloads sehen', description: 'Prompts und Antworten aus Security-Tests sowie Angriffs-Datensätze einsehen; Freigabestufe für Security-Vorlagen' },
  { key: 'runs.prod', label: 'Prod-Läufe freigeben', description: 'Läufe auf Prod-Zielen und Lasttests freigeben, Kill-Switch auslösen' },
  { key: 'reports.approve', label: 'Berichte freigeben', description: 'Prüfberichte als Reviewer freigeben' },
  { key: 'findings.manage', label: 'Findings verwalten', description: 'Findings bearbeiten, zuweisen und Status ändern' },
  { key: 'tenants.manage', label: 'Mandanten verwalten', description: 'Mandanten anlegen und ändern (global)' },
  { key: 'settings.manage', label: 'Systemeinstellungen', description: 'Globale Einstellungen wie KI-Analyse-Modell, Aufbewahrung und Kill-Switch' },
  { key: 'audit.view', label: 'Audit-Log lesen', description: 'Das globale Audit-Log einsehen' },
];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
// Gelten für die ganze Installation und nicht für einen Mandanten: nur System-Administratoren erhalten sie über die Admin-Rolle.
export const SYSTEM_PERMISSIONS = ['roles.manage', 'tenants.manage', 'settings.manage', 'audit.view'];
export const TENANT_PERMISSION_KEYS = PERMISSION_KEYS.filter((k) => !SYSTEM_PERMISSIONS.includes(k));

// Admin per Umgebungsvariable: nur mit von Keycloak bestätigter E-Mail.
export function isEnvAdmin(user, adminEmails) {
  return Boolean(user?.email && user.email_verified && adminEmails.includes(user.email.toLowerCase()));
}

// Effektive Berechtigungen im aktuellen Mandanten: System-Administratoren (globale Admin-Rolle oder ADMIN_EMAILS) haben alle,
// Mandanten-Administratoren alle mandantenbezogenen, sonst die Vereinigung der Rollen.
export function effectivePermissions({ rolePermissions = [], hasAdminRole = false, tenantAdmin = false, envAdmin = false }) {
  if (hasAdminRole || envAdmin) return [...PERMISSION_KEYS];
  if (tenantAdmin) return [...TENANT_PERMISSION_KEYS];
  return PERMISSION_KEYS.filter((k) => rolePermissions.includes(k) && !(SYSTEM_PERMISSIONS.includes(k) && !hasAdminRole));
}

export function hasPermission(user, permission) {
  return Boolean(user && !user.disabled && user.permissions?.includes(permission));
}
