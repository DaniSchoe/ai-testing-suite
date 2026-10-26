import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, TrendingDown } from 'lucide-react';
import { fmt, StatusBadge, TYPE_LABELS, useApi } from '../lib.jsx';

const COLUMNS = [
  ['started_at', 'Gestartet'],
  ['test_name', 'Test'],
  ['type', 'Testart'],
  ['model', 'Modell'],
  ['status', 'Status'],
  ['score', 'Score', 'num'],
  ['duration_ms', 'Dauer', 'num'],
];

// Wichtigste Kennzahl je Testart für die Tabellenspalte.
function keyMetric(r) {
  const m = r.metrics ?? {};
  switch (r.type) {
    case 'performance':
      return `TTFT p95 ${fmt.ms(m.ttft_ms_p95)} · ${fmt.num(m.tokens_per_s_avg, 0)} tok/s`;
    case 'load':
      return `${fmt.num(m.peak_requests_per_s)} req/s · Fehler ${fmt.pct(m.error_rate)}`;
    case 'ratelimit':
      return `${m.succeeded ?? '–'} ok / ${m.rate_limited ?? '–'} × 429`;
    case 'access':
      return `${m.passed}/${m.cases} korrekt${m.false_allow ? ` · ${m.false_allow} falsch erlaubt` : ''}`;
    case 'mcp':
      return `${m.passed}/${m.checks} Checks${m.tools_leaked ? ` · ${m.tools_leaked} Tools zu viel` : ''}`;
    case 'smoke':
      return `${m.models_healthy}/${m.models_expected} Modelle ok`;
    case 'thinking':
      return `Genauigkeit ${m.accuracy_gain >= 0 ? '+' : ''}${fmt.num((m.accuracy_gain ?? 0) * 100, 0)} Pkt. · ${fmt.num(m.token_factor)}× Tokens`;
    case 'comparison':
      return `Bestes Ergebnis: ${m.best ?? m.best_model ?? '–'}`;
    default:
      return m.cases !== undefined ? `${m.passed}/${m.cases} Fälle` : '';
  }
}

export default function History() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('results');
  const scope = params.get('scope') ?? 'me';
  const sort = params.get('sort') ?? 'started_at';
  const dir = params.get('dir') ?? 'desc';
  const page = Number(params.get('page') ?? 1);
  const query = new URLSearchParams({
    scope,
    sort,
    dir,
    page: String(page),
    pageSize: '25',
    type: params.get('type') ?? '',
    status: params.get('status') ?? '',
    search: params.get('search') ?? '',
  });
  const results = useApi(tab === 'results' ? `/api/results?${query}` : null, { interval: 10000 });
  const runs = useApi(tab === 'runs' ? `/api/runs?scope=${scope}&limit=100` : null, { interval: 5000 });

  function update(patch) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }

  function sortBy(key) {
    update({ sort: key, dir: sort === key && dir === 'desc' ? 'asc' : 'desc' });
  }

  const totalPages = results.data ? Math.max(1, Math.ceil(results.data.total / results.data.pageSize)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{scope === 'me' ? 'Meine Tests' : 'Alle Tests'}</h1>
          <p>Jede Testausführung mit Ergebnis, Kennzahlen und Verlauf. Klick öffnet den Lauf mit Logs.</p>
        </div>
        <div className="btn-row">
          <div className="segmented">
            <button className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>
              Testergebnisse
            </button>
            <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
              Läufe
            </button>
          </div>
          <div className="segmented">
            <button className={scope === 'me' ? 'active' : ''} onClick={() => update({ scope: 'me' })}>
              Nur ich
            </button>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => update({ scope: 'all' })}>
              Alle Nutzer
            </button>
          </div>
        </div>
      </div>

      {tab === 'results' && (
        <div className="card">
          <div className="toolbar">
            <input placeholder="Suche nach Test, Modell, Endpoint" defaultValue={params.get('search') ?? ''} onKeyDown={(e) => e.key === 'Enter' && update({ search: e.target.value })} />
            <select value={params.get('type') ?? ''} onChange={(e) => update({ type: e.target.value })} aria-label="Testart">
              <option value="">Alle Testarten</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select value={params.get('status') ?? ''} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
              <option value="">Alle Status</option>
              <option value="passed">Bestanden</option>
              <option value="failed">Fehlgeschlagen</option>
              <option value="error">Fehler</option>
              <option value="running">Läuft</option>
            </select>
            <span className="sub" style={{ marginLeft: 'auto' }}>
              {results.data?.total ?? 0} Einträge
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map(([key, label, cls]) => (
                    <th key={key} className={`sortable ${cls ?? ''}`} onClick={() => sortBy(key)} aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      {label} {sort === key && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </th>
                  ))}
                  <th>Kennzahl</th>
                  {scope === 'all' && <th>Nutzer</th>}
                </tr>
              </thead>
              <tbody>
                {(results.data?.rows ?? []).map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.run_id}#${r.id}`)}>
                    <td className="sub" style={{ whiteSpace: 'nowrap' }}>
                      {fmt.date(r.started_at)}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.test_name}</div>
                      <div className="sub">
                        {r.endpoint_name}
                        {r.persona_name ? ` · als ${r.persona_name}` : ''}
                        {r.trigger === 'schedule' ? ' · geplant' : ''}
                      </div>
                    </td>
                    <td>{TYPE_LABELS[r.type] ?? r.type}</td>
                    <td>{r.model ?? '–'}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      {r.regression && (
                        <span className="badge warn" style={{ marginLeft: 4 }} title="Schlechter als die letzte bestandene Ausführung">
                          <TrendingDown size={12} /> Regression
                        </span>
                      )}
                    </td>
                    <td className="num">{fmt.pct(r.score)}</td>
                    <td className="num">{fmt.ms(r.duration_ms)}</td>
                    <td className="sub">{r.error ? <span style={{ color: 'var(--bad)' }}>{r.error.slice(0, 80)}</span> : keyMetric(r)}</td>
                    {scope === 'all' && <td>{r.user_name ?? 'Zeitplan'}</td>}
                  </tr>
                ))}
                {results.data?.rows?.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      Keine Testausführungen gefunden
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="toolbar" style={{ borderTop: '1px solid var(--border)', borderBottom: 0, justifyContent: 'flex-end' }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              Zurück
            </button>
            <span className="sub">
              Seite {page} von {totalPages}
            </span>
            <button className="btn sm" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })}>
              Weiter
            </button>
          </div>
        </div>
      )}

      {tab === 'runs' && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Gestartet</th>
                <th>Lauf</th>
                <th>Auslöser</th>
                <th>Status</th>
                <th className="num">Bestanden</th>
                <th className="num">Fehlgeschlagen</th>
                <th className="num">Dauer</th>
                {scope === 'all' && <th>Nutzer</th>}
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td className="sub">{fmt.date(r.created_at)}</td>
                  <td style={{ fontWeight: 600 }}>{r.label}</td>
                  <td>{{ manual: 'Manuell', schedule: 'Zeitplan', api: 'API' }[r.trigger]}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="num">
                    {r.passed}/{r.total}
                  </td>
                  <td className="num">{r.failed + r.errored}</td>
                  <td className="num">{r.finished_at && r.started_at ? fmt.ms(new Date(r.finished_at) - new Date(r.started_at)) : '–'}</td>
                  {scope === 'all' && <td>{r.user_name ?? 'Zeitplan'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
