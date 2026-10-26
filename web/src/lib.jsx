// Gemeinsame Helfer: API-Zugriff, Formatierung, Theme, kleine UI-Bausteine.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { X } from 'lucide-react';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    window.location.href = '/auth/login';
    throw new Error('Nicht angemeldet');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// Lädt Daten und lädt optional periodisch nach (z. B. solange Läufe aktiv sind).
export function useApi(path, { interval } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api(path);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
  }, [load]);
  useEffect(() => {
    if (!interval) return undefined;
    const id = setInterval(load, interval);
    return () => clearInterval(id);
  }, [interval, load]);
  return { ...state, reload: load };
}

export const UserContext = createContext(null);
export const useUser = () => useContext(UserContext);
// Berechtigungen kommen vom Server (/api/me), z. B. can(user, 'runs.start').
export function can(user, permission) {
  return Boolean(user?.permissions?.includes(permission));
}

// Umfang für Dashboard und Ergebnisse: 'all' (alle Nutzer), 'me' oder 'team:<id>'.
// Ohne results.view_all stehen nur "Nur ich" und die eigenen Teams zur Wahl.
export function ScopePicker({ value, onChange }) {
  const user = useUser();
  const viewAll = can(user, 'results.view_all');
  const allTeams = useApi(viewAll ? '/api/teams' : null);
  const teams = viewAll ? (allTeams.data ?? []) : (user.teams ?? []);
  const teamId = value.startsWith('team:') ? value.slice(5) : '';
  return (
    <>
      <div className="segmented" role="tablist" aria-label="Umfang">
        {viewAll && (
          <button className={value === 'all' ? 'active' : ''} onClick={() => onChange('all')}>
            Alle Nutzer
          </button>
        )}
        <button className={value === 'me' ? 'active' : ''} onClick={() => onChange('me')}>
          Nur ich
        </button>
      </div>
      {teams.length > 0 && (
        <select className="inline" value={teamId} onChange={(e) => onChange(e.target.value ? `team:${e.target.value}` : 'me')} aria-label="Team">
          <option value="">Team wählen…</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

export function scopeParams(value) {
  return value.startsWith('team:') ? { scope: 'team', teamId: value.slice(5) } : { scope: value };
}

export function scopeLabel(value, user, teams = []) {
  if (value === 'me') return 'Deine eigenen Testläufe';
  if (value === 'all') return 'Auswertung über alle Nutzer';
  const id = value.slice(5);
  const team = [...(user.teams ?? []), ...teams].find((t) => t.id === id);
  return `Testläufe von Team ${team?.name ?? ''}`.trim();
}

// Theme: 'light' | 'dark' | 'system', gespeichert pro Browser.
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('theme') || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* Speicher nicht verfügbar */
    }
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

export const TYPE_LABELS = {
  smoke: 'Health / Smoke',
  performance: 'Performance',
  load: 'Last',
  quality: 'Qualität',
  comparison: 'Modell-Vergleich',
  security: 'Security / DLP',
  access: 'Zugriff',
  mcp: 'MCP',
  ratelimit: 'Rate-Limits',
  structured: 'Tool-Calling / JSON',
  thinking: 'Thinking vs. Non-Thinking',
};

export const STATUS_LABELS = {
  passed: 'Bestanden',
  failed: 'Fehlgeschlagen',
  error: 'Fehler',
  running: 'Läuft',
  queued: 'Wartet',
  cancelled: 'Abgebrochen',
  skipped: 'Übersprungen',
};

export function StatusBadge({ status }) {
  const icon = { passed: '✓', failed: '✕', error: '!', running: '◌', queued: '…', cancelled: '–' }[status] ?? '';
  return (
    <span className={`badge ${status}`}>
      {icon} {STATUS_LABELS[status] ?? status}
    </span>
  );
}

const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
export const fmt = {
  num: (v, digits = 1) =>
    v === null || v === undefined || Number.isNaN(v) ? '–' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(v),
  pct: (v) => (v === null || v === undefined ? '–' : `${nf.format(v * 100)} %`),
  ms: (v) => (v === null || v === undefined ? '–' : v >= 1000 ? `${nf.format(v / 1000)} s` : `${Math.round(v)} ms`),
  date: (v) => (v ? new Date(v).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'),
  day: (v) => new Date(v).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
  ago(v) {
    if (!v) return '–';
    const s = (Date.now() - new Date(v).getTime()) / 1000;
    if (s < 60) return 'gerade eben';
    if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
    if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
    return `vor ${Math.round(s / 86400)} Tagen`;
  },
};

export function initials(name = '') {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('') || '?'
  );
}

export function Modal({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Schließen">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Card({ title, sub, action, children, flush }) {
  return (
    <section className="card">
      {(title || action) && (
        <div className="card-head">
          <div>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          {action}
        </div>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function JsonField({ label, value, onChange, rows = 14, hint }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState(null);
  // Wert wird nur initial übernommen; von außen zurücksetzen über ein neues `key`.
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        className="mono"
        rows={rows}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            setError(null);
            onChange(parsed, true);
          } catch {
            setError('Ungültiges JSON');
            onChange(null, false);
          }
        }}
      />
      {error ? <div className="hint" style={{ color: 'var(--bad)' }}>{error}</div> : hint && <div className="hint">{hint}</div>}
    </label>
  );
}
