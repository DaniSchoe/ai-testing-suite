import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Boxes,
  AlertTriangle,
  Database,
  FileText,
  FlaskConical,
  History as HistoryIcon,
  KeyRound,
  LayoutGrid,
  Layers,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Ruler,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Store,
  Sun,
  Users,
  Building2,
} from 'lucide-react';
import { api, can, getPlatform, getTenant, initials, setPlatform, setPlatformQuiet, setTenant, useApi, UserContext, useTheme } from './lib.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Findings from './pages/Findings.jsx';
import { ReportDetail, Reports } from './pages/Reports.jsx';
import { AuditEditor, Audits } from './pages/Audits.jsx';
import { Runs } from './pages/Runs.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Sovereignty from './pages/Sovereignty.jsx';
import { Catalog, TemplateDetail } from './pages/Catalog.jsx';
import { DatasetDetail, Datasets } from './pages/Datasets.jsx';
import { PlatformDetail, Platforms } from './pages/Platforms.jsx';
import Models from './pages/admin/Models.jsx';
import Sizing from './pages/Sizing.jsx';
import Credentials from './pages/Credentials.jsx';
import Members from './pages/Members.jsx';
import Tenants from './pages/admin/Tenants.jsx';
import Roles from './pages/admin/Roles.jsx';
import AuditLog from './pages/admin/AuditLog.jsx';
import SystemSettings from './pages/admin/SystemSettings.jsx';
import ModelDetail from './pages/ModelDetail.jsx';

// Navigation nach Aufgaben. Gruppen ohne sichtbare Einträge werden ausgeblendet.
const any = (...p) => (user) => p.some((x) => can(user, x));
const NAV = [
  {
    label: 'Übersicht',
    items: [['/', LayoutGrid, 'Dashboard', any('suite.view'), { end: true }]],
  },
  {
    label: 'Prüfen',
    items: [
      ['/audits', FlaskConical, 'Prüfungen', any('tests.manage', 'runs.start'), { warn: 'approvals' }],
      ['/runs', HistoryIcon, 'Läufe', any('suite.view'), { badge: 'runs' }],
    ],
  },
  {
    label: 'Katalog',
    items: [
      ['/catalog', Store, 'Vorlagen', any('tests.manage', 'catalog.publish')],
      ['/datasets', Database, 'Datensätze', any('tests.manage')],
    ],
  },
  {
    label: 'Ziele',
    items: [
      ['/platforms', Layers, 'Plattformen', any('endpoints.manage', 'tests.manage', 'runs.start')],
      ['/models', Boxes, 'Modellportfolio', any('endpoints.manage')],
      ['/sizing', Ruler, 'Sizing', any('endpoints.manage', 'runs.start'), { tag: 'Beta' }],
    ],
  },
  {
    label: 'Verwaltung',
    items: [
      ['/credentials', KeyRound, 'Zugangsdaten', any('tests.manage', 'runs.start', 'endpoints.manage')],
      ['/members', Users, 'Mitglieder & Teams', any('users.manage', 'teams.manage')],
    ],
  },
  {
    label: 'Administration',
    items: [
      ['/admin/tenants', Building2, 'Mandanten', any('tenants.manage')],
      ['/admin/roles', ShieldCheck, 'Rollen', any('roles.manage')],
      ['/admin/audit-log', ScrollText, 'Audit-Log', any('audit.view')],
      ['/admin/settings', Settings, 'Systemeinstellungen', any('settings.manage')],
    ],
  },
];

// Angemeldet, aber (noch) ohne Berechtigung: Admin muss eine Rolle vergeben oder das Konto entsperren.
function NoAccess({ user }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
      <div className="card" style={{ maxWidth: 460, padding: 28 }}>
        <h1 style={{ marginTop: 0, fontSize: 20 }}>{user.disabled ? 'Konto gesperrt' : 'Noch kein Zugriff'}</h1>
        <p style={{ color: 'var(--text-2)' }}>
          Du bist als <strong>{user.email ?? user.username}</strong> angemeldet.{' '}
          {user.disabled
            ? 'Dein Konto wurde von einem Administrator gesperrt.'
            : 'Ein Administrator muss dir in der AI Testing Suite zuerst eine Rolle zuweisen.'}
        </p>
        <a className="btn" href="/auth/logout">
          <LogOut size={15} /> Abmelden
        </a>
      </div>
    </div>
  );
}

// Plattformauswahl oben rechts: begrenzt Dashboard und alle Listen auf die gewählte Plattform.
function PlatformSwitch({ platforms, current }) {
  if (!platforms.length) return <span className="tag">Keine Plattform</span>;
  return (
    <select className="inline" value={current ?? ''} onChange={(e) => setPlatform(e.target.value)} aria-label="Plattform">
      {platforms.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.environment === 'dev' ? 'Dev' : 'Prod'})
        </option>
      ))}
    </select>
  );
}

function TenantSwitch({ user }) {
  const tenants = user.tenants ?? [];
  if (tenants.length < 2) return <span className="tag">{user.tenant?.name}</span>;
  return (
    <select className="inline" value={getTenant() ?? user.tenant?.id} onChange={(e) => setTenant(e.target.value)} aria-label="Mandant">
      {tenants.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // Aktive Läufe als Zähler in der Navigation (wie "Meine Aufgaben" in der Vorlage).
  const active = useApi(can(user, 'suite.view') ? '/api/runs?status=active&limit=50' : null, { interval: 10000 });
  const platformList = useApi(can(user, 'suite.view') ? '/api/platforms' : null);
  const pendingApprovals = useApi(can(user, 'runs.prod') ? '/api/approvals/summary' : null, { interval: 30000 });
  const badges = {
    runs: (active.data?.runs ?? []).filter((r) => r.status === 'running' || r.status === 'queued').length,
    approvals: pendingApprovals.data?.pending ?? 0,
  };

  useEffect(() => {
    api('/api/me').then(setUser).catch(() => {});
  }, []);
  useEffect(() => setNavOpen(false), [location.pathname]);

  if (!user) return null;
  if (!can(user, 'suite.view')) return <NoAccess user={user} />;
  if (!platformList.data && !platformList.error) return null;
  const platforms = platformList.data ?? [];
  // Gewählte Plattform aus dem Browser; ist sie unbekannt, gilt die erste. Seiten lesen sie über getPlatform().
  const current = platforms.find((p) => p.id === getPlatform())?.id ?? platforms[0]?.id ?? null;
  if (current !== getPlatform()) setPlatformQuiet(current);
  const name = user.display_name ?? user.username;
  const roleLabel = user.env_admin ? 'Administrator' : user.roles.map((r) => r.name).join(', ') || 'Ohne Rolle';

  return (
    <UserContext.Provider value={user}>
      <div className="shell">
        <aside className={`sidebar${navOpen ? ' open' : ''}`}>
          <div className="brand">
            <div className="brand-logo">A</div>
            AI Suite <span className="brand-tag">TEST</span>
          </div>
          {NAV.map((group) => {
            const items = group.items.filter(([, , , visible]) => visible(user));
            if (!items.length) return null;
            return (
              <div key={group.label}>
                <div className="nav-section">{group.label}</div>
                <nav className="nav">
                  {items.map(([to, Icon, label, , opts = {}]) => (
                    <NavLink key={to} to={to} end={opts.end}>
                      <Icon size={18} /> {label}
                      {opts.tag && <span className="tag nav-tag">{opts.tag}</span>}
                      {opts.warn && badges[opts.warn] > 0 && (
                        <span className="nav-warn" title={`${badges[opts.warn]} offene Freigaben warten auf dich`} aria-label="Offene Freigaben">
                          <AlertTriangle size={15} />
                        </span>
                      )}
                      {opts.badge && badges[opts.badge] > 0 && <span className="count">{badges[opts.badge]}</span>}
                    </NavLink>
                  ))}
                </nav>
              </div>
            );
          })}
          <div className="sidebar-footer">
            <div className="theme-switch" role="radiogroup" aria-label="Darstellung">
              {[
                ['light', 'Hell', Sun],
                ['dark', 'Dunkel', Moon],
                ['system', 'System', Monitor],
              ].map(([key, label, Icon]) => (
                <button key={key} className={theme === key ? 'active' : ''} onClick={() => setTheme(key)} role="radio" aria-checked={theme === key}>
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
            <div className="user-card">
              <div className="avatar">{initials(name)}</div>
              <div>
                <div className="name">{name}</div>
                <div className="role">{roleLabel}</div>
              </div>
              <a href="/auth/logout" title="Abmelden" aria-label="Abmelden">
                <LogOut size={18} />
              </a>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button className="btn ghost mobile-only" onClick={() => setNavOpen((o) => !o)} aria-label="Menü">
              <Menu size={18} />
            </button>
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate(`/runs?search=${encodeURIComponent(query)}`);
              }}
            >
              <Search size={16} />
              <input type="search" placeholder="Läufe und Prüfungen durchsuchen…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </form>
            <div className="spacer" />
            <TenantSwitch user={user} />
            <PlatformSwitch platforms={platforms} current={current} />
            <span className="app-version" title="Version der Anwendung">v{user.version}</span>
          </header>
          <main className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/findings" element={<Findings />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/reports/:id" element={<ReportDetail />} />
              <Route path="/audits" element={<Audits />} />
              <Route path="/audits/new" element={<AuditEditor />} />
              <Route path="/audits/:id" element={<AuditEditor />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/sovereignty" element={<Sovereignty />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/catalog/templates/:id" element={<TemplateDetail />} />
              <Route path="/datasets" element={<Datasets />} />
              <Route path="/datasets/:id" element={<DatasetDetail />} />
              <Route path="/platforms" element={<Platforms />} />
              <Route path="/platforms/:id" element={<PlatformDetail />} />
              <Route path="/models" element={<Models />} />
              <Route path="/models/:name" element={<ModelDetail />} />
              <Route path="/sizing" element={<Sizing />} />
              <Route path="/credentials" element={<Credentials />} />
              <Route path="/members" element={<Members />} />
              <Route path="/admin/tenants" element={<Tenants />} />
              <Route path="/admin/roles" element={<Roles />} />
              <Route path="/admin/audit-log" element={<AuditLog />} />
              <Route path="/admin/settings" element={<SystemSettings />} />
              <Route path="*" element={<div className="empty">Seite nicht gefunden</div>} />
            </Routes>
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}
