import { Link } from 'react-router-dom';
import { Archive, Building2, ScrollText, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { can, PageHead, useUser } from '../../lib.jsx';

const any = (user, ...p) => p.some((x) => can(user, x));

// Einstieg in die Systemeinstellungen: jede Kachel führt zur jeweiligen Verwaltungsansicht.
const TILES = [
  ['/admin/organization', Building2, 'Organization', 'Mandanten, Abteilungen und Teams als Hierarchie.', (u) => any(u, 'tenants.manage', 'teams.manage', 'users.manage')],
  ['/admin/users', Users, 'User', 'User verwalten, Rollen vergeben und Teams zuordnen.', (u) => any(u, 'users.manage', 'teams.manage')],
  ['/admin/roles', ShieldCheck, 'Rollen', 'Rollen und ihre Berechtigungen.', (u) => any(u, 'roles.manage')],
  ['/admin/audit-log', ScrollText, 'Audit-Log', 'Wer hat wann was geändert.', (u) => any(u, 'audit.view')],
  ['/admin/analysis', Sparkles, 'KI-Analyse', 'Modell, das Testläufe automatisch auswertet.', (u) => Boolean(u.is_admin)],
  ['/admin/archive', Archive, 'Archivierung', 'Aufbewahrungsfristen für Nachweise.', (u) => any(u, 'settings.manage')],
];

export default function SystemSettings() {
  const user = useUser();
  const tiles = TILES.filter(([, , , , visible]) => visible(user));
  return (
    <>
      <PageHead title="Systemeinstellungen">Organisation, User, Rollen, Protokoll und Aufbewahrung.</PageHead>
      {tiles.length === 0 && <div className="card empty">Keine Einstellungen für deine Rolle verfügbar</div>}
      <div className="tile-grid">
        {tiles.map(([to, Icon, title, text]) => (
          <Link key={to} to={to} className="tile">
            <span className="tile-icon">
              <Icon size={18} />
            </span>
            <h3>{title}</h3>
            <div className="sub">{text}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
