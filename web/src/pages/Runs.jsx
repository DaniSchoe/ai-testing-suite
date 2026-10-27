import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { api, Empty, EnvBadge, getPlatform, Loading, OUTCOME_LABELS, PageHead, qs, StatusBadge, Tabs, useApi, useUser, fmt } from '../lib.jsx';
import { Calendar } from './Schedules.jsx';

const outcomeText = (o) =>
  Object.entries(o ?? {})
    .map(([k, n]) => `${n} ${OUTCOME_LABELS[k] ?? k}`)
    .join(' · ');

export function Runs() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('list');
  const [filters, setFilters] = useState({ audit_id: '', platform_id: getPlatform() ?? '', status: '', days: '30', drafts: '' });
  const [page, setPage] = useState(1);
  const search = params.get('search') ?? '';
  const options = useApi('/api/run-filters');
  const list = useApi(`/api/runs${qs({ ...filters, page, search })}`, { interval: 10000 });
  const set = (patch) => (setFilters((f) => ({ ...f, ...patch })), setPage(1));
  const remove = async (r) => {
    if (!confirm(`Lauf „${r.label}“ löschen? Damit gehen auch alle erzeugten Daten verloren: Ergebnisse, Logs und Nachweise. Das lässt sich nicht rückgängig machen.`)) return;
    try {
      await api(`/api/runs/${r.id}`, { method: 'DELETE' });
      list.reload();
    } catch (e) {
      alert(e.message);
    }
  };
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <>
      <PageHead title="Historie">Jede Ausführung einer Prüfung mit Ergebnis, Gate und Nachweisen. Testläufe aus dem Katalog zählen hier nicht mit und sind unter „Meine Testläufe“ zu finden.</PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['list', 'Liste'],
          ['calendar', 'Kalender'],
        ]}
      />
      {tab === 'calendar' && <Calendar />}
      {tab === 'list' && (
        <>
          <div className="toolbar">
            <input type="search" placeholder="Läufe suchen…" value={search} onChange={(e) => setParams(e.target.value ? { search: e.target.value } : {})} />
            <select className="inline" value={filters.audit_id} onChange={(e) => set({ audit_id: e.target.value })} aria-label="Prüfung">
              <option value="">Alle Prüfungen</option>
              {(options.data?.audits ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select className="inline" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
              <option value="">Alle Stände</option>
              <option value="active">Aktiv</option>
              <option value="passed">Bestanden</option>
              <option value="failed">Nicht bestanden</option>
              <option value="cancelled">Abgebrochen</option>
            </select>
            <select className="inline" value={filters.days} onChange={(e) => set({ days: e.target.value })} aria-label="Zeitraum">
              <option value="7">7 Tage</option>
              <option value="30">30 Tage</option>
              <option value="90">90 Tage</option>
              <option value="365">12 Monate</option>
              <option value="">Gesamt</option>
            </select>
            <label className="checkbox">
              <input type="checkbox" checked={filters.drafts === '1'} onChange={(e) => set({ drafts: e.target.checked ? '1' : '' })} />
              Meine Testläufe
            </label>
          </div>
          <Loading state={list}>
            {(d) =>
              d.runs.length === 0 ? (
                <Empty>Keine Läufe gefunden.</Empty>
              ) : (
                <>
                  <div className="card table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Zeitpunkt</th>
                          <th>Lauf</th>
                          <th>Ziel</th>
                          <th>Status</th>
                          <th>Ergebnis</th>
                          <th>Auslöser</th>
                          {user.is_admin && <th />}
                        </tr>
                      </thead>
                      <tbody>
                        {d.runs.map((r) => (
                          <tr key={r.id}>
                            <td className="sub">{fmt.date(r.created_at)}</td>
                            <td>
                              <Link className="title-link" to={`/runs/${r.id}`}>
                                {r.label}
                              </Link>
                              {r.is_draft && <span className="badge warn" style={{ marginLeft: 6 }}>Testlauf</span>}
                            </td>
                            <td>
                              {r.platform_name} {r.platform_environment && <EnvBadge env={r.platform_environment} />}
                            </td>
                            <td>
                              <StatusBadge status={r.status} />
                            </td>
                            <td className="sub">
                              {outcomeText(r.outcomes) || `${r.passed}/${r.total}`}
                              {r.regressions > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{r.regressions} Regression</span>}
                            </td>
                            <td className="sub">
                              {r.user_name ?? 'Zeitplan'} · {r.trigger}
                            </td>
                            {user.is_admin && (
                              <td className="num">
                                {!['queued', 'running'].includes(r.status) && (
                                  <button className="btn sm ghost danger" onClick={() => remove(r)} aria-label="Lauf löschen">
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {pages > 1 && (
                    <div className="btn-row" style={{ marginTop: 12, justifyContent: 'center' }}>
                      <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                        Zurück
                      </button>
                      <span className="sub">
                        Seite {page} von {pages} ({d.total} Läufe)
                      </span>
                      <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                        Weiter
                      </button>
                    </div>
                  )}
                </>
              )
            }
          </Loading>
        </>
      )}
    </>
  );
}
