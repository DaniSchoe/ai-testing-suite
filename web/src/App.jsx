import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  CalendarClock,
  FlaskConical,
  KeyRound,
  LayoutGrid,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  Search,
  Sun,
  Table2,
  Users,
} from 'lucide-react';
import { api, can, initials, useApi, UserContext, useTheme } from './lib.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Tests from './pages/Tests.jsx';
import Suites from './pages/Suites.jsx';
import Schedules from './pages/Schedules.jsx';
import History from './pages/History.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Endpoints from './pages/admin/Endpoints.jsx';
import Personas from './pages/admin/Personas.jsx';
import UsersPage from './pages/admin/Users.jsx';

const ROLE_LABEL = { admin: 'Administrator', tester: 'Tester', viewer: 'Betrachter' };

export default function App() {
  const [user, setUser] = useState(null);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // Aktive Läufe als Zähler in der Navigation (wie "Meine Aufgaben" in der Vorlage).
  const active = useApi(user ? '/api/runs?scope=me&limit=50' : null, { interval: 10000 });
  const activeCount = (active.data ?? []).filter((r) => r.status === 'running' || r.status === 'queued').length;

  useEffect(() => {
    api('/api/me').then(setUser).catch(() => {});
  }, []);
  useEffect(() => setNavOpen(false), [location.pathname]);

  if (!user) return null;
  const name = user.display_name ?? user.username;
  const topRole = ['admin', 'tester', 'viewer'].find((r) => user.roles.includes(r));

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
            <NavLink to="/tests">
              <FlaskConical size={18} /> Tests
            </NavLink>
            <NavLink to="/suites">
              <ListChecks size={18} /> Testläufe bündeln
            </NavLink>
            <NavLink to="/schedules">
              <CalendarClock size={18} /> Zeitpläne
            </NavLink>
            <NavLink to="/history">
              <Table2 size={18} /> Meine Tests
              {activeCount > 0 && <span className="count">{activeCount}</span>}
            </NavLink>
          </nav>
          {can(user, 'admin') && (
            <>
              <div className="nav-section">Administrator</div>
              <nav className="nav">
                <NavLink to="/admin/endpoints">
                  <Network size={18} /> Endpoints
                </NavLink>
                <NavLink to="/admin/personas">
                  <KeyRound size={18} /> Test-Personas
                </NavLink>
                <NavLink to="/admin/users">
                  <Users size={18} /> Benutzer
                </NavLink>
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
                <div className="role">{ROLE_LABEL[topRole] ?? 'Ohne Rolle'}</div>
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
          </header>
          <main className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tests" element={<Tests />} />
              <Route path="/suites" element={<Suites />} />
              <Route path="/schedules" element={<Schedules />} />
              <Route path="/history" element={<History />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/admin/endpoints" element={<Endpoints />} />
              <Route path="/admin/personas" element={<Personas />} />
              <Route path="/admin/users" element={<UsersPage />} />
              <Route path="*" element={<div className="empty">Seite nicht gefunden</div>} />
            </Routes>
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}
