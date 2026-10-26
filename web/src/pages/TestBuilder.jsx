import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, Eye, EyeOff, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api, can, describeSchedule, fmt, Modal, StatusBadge, TeamPicker, TYPE_LABELS, useApi, useTeams, useUser, VisibilityBadge } from '../lib.jsx';
import { typeIcon } from '../testTypeDocs.js';

export function TypeIcons({ types }) {
  return (
    <span className="type-icons">
      {types.map((t) => {
        const Icon = typeIcon(t);
        return (
          <span key={t} className="icon-chip" title={TYPE_LABELS[t] ?? t} style={{ width: 26, height: 26 }}>
            <Icon size={14} />
          </span>
        );
      })}
    </span>
  );
}

// Liste der gebauten Tests mit Ausführen, Bearbeiten, Veröffentlichen und Zurückziehen.
export default function TestBuilder() {
  const user = useUser();
  const navigate = useNavigate();
  const builds = useApi('/api/builds', { interval: 15000 });
  const teams = useTeams();
  const [filter, setFilter] = useState('');
  const [mine, setMine] = useState(false);
  const [publishing, setPublishing] = useState(null);
  const [error, setError] = useState(null);
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';

  const list = useMemo(
    () =>
      (builds.data ?? []).filter(
        (b) =>
          (!mine || b.mine) &&
          `${b.name} ${b.description ?? ''} ${(b.tags ?? []).join(' ')}`.toLowerCase().includes(filter.toLowerCase()),
      ),
    [builds.data, filter, mine],
  );

  async function act(fn) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
  }

  const run = (b) =>
    act(async () => {
      const r = await api(`/api/builds/${b.id}/run`, { method: 'POST' });
      navigate(`/runs/${r.id}`);
    });
  const remove = (b) =>
    act(async () => {
      if (!confirm(`Test "${b.name}" löschen? Bisherige Ergebnisse bleiben erhalten.`)) return;
      await api(`/api/builds/${b.id}`, { method: 'DELETE' });
      builds.reload();
    });
  const unpublish = (b) =>
    act(async () => {
      await api(`/api/builds/${b.id}/unpublish`, { method: 'POST' });
      builds.reload();
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Test-Builder</h1>
          <p>
            Baue Tests aus Testarten, Endpoint und Modellen, führe sie sofort, einmalig geplant oder regelmäßig aus und veröffentliche sie für dich,
            dein Team oder alle.
          </p>
        </div>
        {can(user, 'tests.manage') && (
          <Link className="btn primary" to="/test-builder/new">
            <Plus size={15} /> Neuer Test
          </Link>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <input type="search" placeholder="Name, Beschreibung oder Tag…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="segmented" role="tablist" aria-label="Umfang">
            <button className={!mine ? 'active' : ''} onClick={() => setMine(false)}>
              Alle sichtbaren
            </button>
            <button className={mine ? 'active' : ''} onClick={() => setMine(true)}>
              Meine Tests
            </button>
          </div>
          <span className="sub" style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
            {list.length} Tests
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th>Testarten</th>
                <th>Ziel</th>
                <th>Ausführung</th>
                <th>Letztes Ergebnis</th>
                <th>Veröffentlicht</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => {
                const schedule = describeSchedule(b);
                return (
                  <tr key={b.id}>
                    <td style={{ minWidth: 240 }}>
                      <div style={{ fontWeight: 600 }}>{b.can_edit ? <Link to={`/test-builder/${b.id}`}>{b.name}</Link> : b.name}</div>
                      {b.description && <div className="sub">{b.description}</div>}
                      <div className="tags" style={{ marginTop: 4 }}>
                        {(b.tags ?? []).map((t) => (
                          <span className="tag" key={t}>
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="sub">
                        {b.maintainer_name ? `Maintainer: ${b.maintainer_name}` : ''}
                        {!b.mine && b.creator_name ? ` · von ${b.creator_name}` : ''}
                      </div>
                    </td>
                    <td>
                      <TypeIcons types={b.types} />
                    </td>
                    <td className="sub">
                      <div>{b.endpoint_name ?? '–'}</div>
                      <div>{b.models.length ? b.models.join(', ') : 'Standardmodell'}</div>
                    </td>
                    <td className="sub">
                      {schedule ? (
                        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                          <CalendarClock size={13} /> {schedule}
                        </span>
                      ) : (
                        'Manuell'
                      )}
                    </td>
                    <td>
                      {b.last_status ? <StatusBadge status={b.last_status} /> : <span className="sub">noch nie</span>}
                      <div className="sub">
                        {b.run_count} Ausführungen · {fmt.ago(b.last_run_at)}
                      </div>
                    </td>
                    <td>
                      <VisibilityBadge visibility={b.visibility === 'private' ? 'user' : b.visibility} teamNames={b.teamIds.map(teamName)} />
                    </td>
                    <td className="num">
                      <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {can(user, 'runs.start') && (
                          <button className="btn sm" onClick={() => run(b)}>
                            <Play size={13} /> Starten
                          </button>
                        )}
                        {b.can_edit && can(user, 'tests.manage') && (
                          <>
                            {b.visibility === 'private' ? (
                              <button className="btn sm" onClick={() => setPublishing(b)}>
                                <Eye size={13} /> Veröffentlichen
                              </button>
                            ) : (
                              <button className="btn sm" onClick={() => unpublish(b)}>
                                <EyeOff size={13} /> Zurückziehen
                              </button>
                            )}
                            <Link className="btn sm ghost" to={`/test-builder/${b.id}`} aria-label="Bearbeiten">
                              <Pencil size={14} />
                            </Link>
                            <button className="btn sm ghost danger" onClick={() => remove(b)} aria-label="Löschen">
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {builds.data && list.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    Keine Tests gefunden. Mit „Neuer Test“ legst du den ersten an.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {publishing && (
        <PublishDialog
          build={publishing}
          teams={user.is_admin ? (teams.data ?? []) : (user.teams ?? [])}
          onClose={() => setPublishing(null)}
          onDone={() => {
            setPublishing(null);
            builds.reload();
          }}
        />
      )}
    </>
  );
}

export function PublishDialog({ build, teams, onClose, onDone }) {
  const [visibility, setVisibility] = useState(build.visibility === 'private' ? 'teams' : build.visibility);
  const [teamIds, setTeamIds] = useState(build.teamIds ?? []);
  const [error, setError] = useState(null);

  async function save() {
    try {
      await api(`/api/builds/${build.id}/publish`, { method: 'POST', body: { visibility, teamIds } });
      onDone();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={`„${build.name}“ veröffentlichen`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save}>
            Veröffentlichen
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      <label className="field">
        <span>Sichtbar für</span>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          <option value="teams">Ein Team (in dem du Mitglied bist)</option>
          <option value="global">Alle (global)</option>
        </select>
      </label>
      {visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}
      <div className="hint" style={{ marginTop: 10 }}>
        Andere sehen den Test im Marketplace und können ihn ausführen. Du kannst ihn jederzeit zurückziehen.
      </div>
    </Modal>
  );
}
