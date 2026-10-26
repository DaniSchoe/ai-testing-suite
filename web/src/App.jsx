import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  CalendarClock,
  History as HistoryIcon,
  FlaskConical,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  Boxes,
  Layers,
  Search,
  ShieldCheck,
  Store,
  Sun,
  Users,
  UsersRound,
} from 'lucide-react';
import { api, can, initials, useApi, UserContext, useTheme } from './lib.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Platform from './pages/Platform.jsx';
import ModelDetail from './pages/ModelDetail.jsx';
import ModelProfiles from './pages/ModelProfiles.jsx';
import Marketplace from './pages/Marketplace.jsx';
import MarketplaceDetail from './pages/MarketplaceDetail.jsx';
import TestBuilder from './pages/TestBuilder.jsx';
import TestEditor from './pages/TestEditor.jsx';
import TestTypeInfo from './pages/TestTypeInfo.jsx';
import Schedules from './pages/Schedules.jsx';
import History from './pages/History.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Endpoints from './pages/admin/Endpoints.jsx';
import ApiKeys from './pages/admin/ApiKeys.jsx';
import UsersPage from './pages/admin/Users.jsx';
import Models from './pages/admin/Models.jsx';
import Roles from './pages/admin/Roles.jsx';
import Teams from './pages/admin/Teams.jsx';

// API-Keys sehen und pflegen alle User (eigene und Team-Keys), der Rest braucht Berechtigungen.
const ADMIN_NAV = [
  ['suite.view', '/admin/api-keys', KeyRound, 'API-Keys'],
  ['endpoints.manage', '/admin/endpoints', Network, 'Endpoints'],
  ['endpoints.manage', '/admin/models', Boxes, 'Modellkatalog'],
  ['users.manage', '/admin/users', Users, 'Benutzer'],
  ['teams.manage', '/admin/teams', UsersRound, 'Teams'],
  ['roles.manage', '/admin/roles', ShieldCheck, 'Rollen'],
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

export default function App() {
  const [user, setUser] = useState(null);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // Aktive Läufe als Zähler in der Navigation (wie "Meine Aufgaben" in der Vorlage).
  const active = useApi(can(user, 'suite.view') ? '/api/runs?scope=me&limit=50' : null, { interval: 10000 });
  const activeCount = (active.data ?? []).filter((r) => r.status === 'running' || r.status === 'queued').length;

  useEffect(() => {
    api('/api/me').then(setUser).catch(() => {});
  }, []);
  useEffect(() => setNavOpen(false), [location.pathname]);

  if (!user) return null;
  if (!can(user, 'suite.view')) return <NoAccess user={user} />;
  const name = user.display_name ?? user.username;
  const roleLabel = user.env_admin ? 'Administrator' : user.roles.map((r) => r.name).join(', ') || 'Ohne Rolle';
  const adminNav = ADMIN_NAV.filter(([permission]) => can(user, permission));

  return (
    <UserContext.Provider value={user}>
      <div className="shell">
        <aside className={`sidebar${navOpen ? ' open' : ''}`}>
          <div className="brand">
            <div className="brand-logo">A</div>
            AI Suite <span className="brand-tag">TEST</span>
          </div>
          <nav className="nav">
            <NavLink to="/" end>
              <LayoutGrid size={18} /> Dashboard
            </NavLink>
            <NavLink to="/platform">
              <Layers size={18} /> Plattform
            </NavLink>
            <NavLink to="/marketplace">
              <Store size={18} /> Marketplace
            </NavLink>
            <NavLink to="/test-builder">
              <FlaskConical size={18} /> Test-Builder
              {activeCount > 0 && <span className="count">{activeCount}</span>}
            </NavLink>
            <NavLink to="/schedules">
              <CalendarClock size={18} /> Zeitpläne
            </NavLink>
            <NavLink to="/history">
              <HistoryIcon size={18} /> Historie
            </NavLink>
          </nav>
          {adminNav.length > 0 && (
            <>
              <div className="nav-section">Einstellungen</div>
              <nav className="nav">
                {adminNav.map(([, to, Icon, label]) => (
                  <NavLink key={to} to={to}>
                    <Icon size={18} /> {label}
                  </NavLink>
                ))}
              </nav>
            </>
          )}
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
                navigate(`/history?search=${encodeURIComponent(query)}`);
              }}
            >
              <Search size={16} />
              <input type="search" placeholder="Tests, Modelle und Endpoints durchsuchen…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </form>
            <div className="spacer" />
            <span className="app-version" title="Version der Anwendung">v{user.version}</span>
          </header>
          <main className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/model-profiles" element={<ModelProfiles />} />
              <Route path="/models/:name" element={<ModelDetail />} />
              <Route path="/platform" element={<Platform />} />
              <Route path="/marketplace" element={<Marketplace />} />
              <Route path="/marketplace/:id" element={<MarketplaceDetail />} />
              <Route path="/test-builder" element={<TestBuilder />} />
              <Route path="/test-builder/new" element={<TestEditor />} />
              <Route path="/test-builder/:id" element={<TestEditor />} />
              <Route path="/test-types/:type" element={<TestTypeInfo />} />
              <Route path="/schedules" element={<Schedules />} />
              <Route path="/history" element={<History />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/admin/endpoints" element={<Endpoints />} />
              <Route path="/admin/models" element={<Models />} />
              <Route path="/admin/api-keys" element={<ApiKeys />} />
              <Route path="/admin/users" element={<UsersPage />} />
              <Route path="/admin/teams" element={<Teams />} />
              <Route path="/admin/roles" element={<Roles />} />
              <Route path="*" element={<div className="empty">Seite nicht gefunden</div>} />
            </Routes>
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}
