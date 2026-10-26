import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, BookmarkCheck, Play } from 'lucide-react';
import { api, fmt, StatusBadge, TYPE_LABELS, useApi, useTeams, VisibilityBadge } from '../lib.jsx';
import { TypeIcons } from './TestBuilder.jsx';

const SORTS = {
  newest: ['Neueste zuerst', (a, b) => new Date(b.published_at ?? b.created_at) - new Date(a.published_at ?? a.created_at)],
  runs: ['Meiste Ausführungen', (a, b) => b.run_count - a.run_count],
  watched: ['Meiste Merklisten', (a, b) => b.watch_count - a.watch_count],
  name: ['Name A–Z', (a, b) => a.name.localeCompare(b.name, 'de')],
  last: ['Zuletzt ausgeführt', (a, b) => new Date(b.last_run_at ?? 0) - new Date(a.last_run_at ?? 0)],
};

// Gebaute Tests entdecken: eigene (privat) und veröffentlichte für Teams oder alle.
export default function Marketplace() {
  const builds = useApi('/api/builds');
  const types = useApi('/api/test-types');
  const teams = useTeams();
  const [f, setF] = useState({ search: '', type: '', scope: '', sort: 'newest', watched: false });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';

  const list = useMemo(
    () =>
      (builds.data ?? [])
        .filter(
          (b) =>
            b.name.toLowerCase().includes(f.search.toLowerCase()) &&
            (!f.type || b.types.includes(f.type)) &&
            (!f.scope || (f.scope === 'private' ? b.visibility === 'private' : f.scope === 'public' ? b.visibility !== 'private' : b.visibility === f.scope)) &&
            (!f.watched || b.watched),
        )
        .sort(SORTS[f.sort][1]),
    [builds.data, f],
  );

  async function toggleWatch(b) {
    await api(`/api/builds/${b.id}/watch`, { method: b.watched ? 'DELETE' : 'POST' });
    builds.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Tests von dir, deinem Team und allen anderen. Merke dir Tests und führe sie mit deinem eigenen API-Key aus, wenn der Herausgeber das vorsieht.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar">
          <input type="search" placeholder="Nach Namen suchen…" value={f.search} onChange={(e) => set({ search: e.target.value })} />
          <select className="inline" value={f.type} onChange={(e) => set({ type: e.target.value })} aria-label="Testart">
            <option value="">Alle Testarten</option>
            {(types.data ?? []).map((t) => (
              <option key={t.type} value={t.type}>
                {TYPE_LABELS[t.type] ?? t.label}
              </option>
            ))}
          </select>
          <select className="inline" value={f.scope} onChange={(e) => set({ scope: e.target.value })} aria-label="Sichtbarkeit">
            <option value="">Privat und öffentlich</option>
            <option value="private">Nur privat</option>
            <option value="public">Nur öffentlich</option>
            <option value="teams">Für Teams</option>
            <option value="global">Global</option>
          </select>
          <select className="inline" value={f.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sortierung">
            {Object.entries(SORTS).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <label className="checkbox">
            <input type="checkbox" checked={f.watched} onChange={(e) => set({ watched: e.target.checked })} /> Nur Merkliste
          </label>
          <span className="sub" style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
            {list.length} Tests
          </span>
        </div>
      </div>
      {builds.data && list.length === 0 && <div className="card empty">Keine Tests gefunden</div>}
      <div className="market-grid">
        {list.map((b) => (
          <section className="card market-card" key={b.id}>
            <div className="card-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <TypeIcons types={b.types} />
                <button className="btn ghost sm" onClick={() => toggleWatch(b)} aria-label={b.watched ? 'Von Merkliste entfernen' : 'Zur Merkliste hinzufügen'} title="Merkliste">
                  {b.watched ? <BookmarkCheck size={16} /> : <Bookmark size={16} />} {b.watch_count}
                </button>
              </div>
              <h3 style={{ margin: '10px 0 2px', fontSize: 15 }}>
                <Link to={`/marketplace/${b.id}`}>{b.name}</Link>
              </h3>
              <div className="sub">
                von {b.creator_name ?? 'unbekannt'} · {fmt.date(b.published_at ?? b.created_at)}
              </div>
              {b.description && <p className="market-desc">{b.description}</p>}
              <div className="tags" style={{ margin: '8px 0' }}>
                {(b.tags ?? []).map((t) => (
                  <span className="tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
              <div className="sub">
                {b.endpoint_name ?? '–'} · {b.models.length ? b.models.join(', ') : 'Standardmodell'}
              </div>
              <div className="market-foot">
                <VisibilityBadge visibility={b.visibility === 'private' ? 'user' : b.visibility} teamNames={b.teamIds.map(teamName)} />
                <span className="sub">
                  <Play size={11} style={{ verticalAlign: -1 }} /> {b.run_count}
                </span>
                {b.last_status && <StatusBadge status={b.last_status} />}
              </div>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
