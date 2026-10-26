import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, ListFilter, TrendingDown } from 'lucide-react';
import FilterDialog from '../components/FilterDialog.jsx';
import { fmt, ScopePicker, scopeLabel, scopeParams, StatusBadge, TYPE_LABELS, useApi, useUser } from '../lib.jsx';

// Wichtigste Kennzahl je Testart für die Ergebniszeile.
function keyMetric(r) {
  const m = r.metrics ?? {};
  switch (r.type) {
    case 'performance':
      return `TTFT p95 ${fmt.ms(m.ttft_ms_p95)} · ${fmt.num(m.tokens_per_s_avg, 0)} tok/s`;
    case 'load':
      return `${fmt.num(m.peak_requests_per_s)} req/s · Fehler ${fmt.pct(m.error_rate)}${m.rate_limited ? ` · ${m.rate_limited}× 429` : ''}`;
    case 'coding':
      return `${m.tests_passed}/${m.tests_total} Tests`;
    case 'ocr':
      return `${m.fields_correct}/${m.fields_total} Felder`;
    case 'quality':
      return `${m.passed}/${m.cases} Fragen · höchste Stufe ${m.highest_level ?? '–'}`;
    case 'access':
      return `${m.passed}/${m.cases} korrekt${m.false_allow ? ` · ${m.false_allow} falsch erlaubt` : ''}`;
    case 'mcp':
      return `${m.passed}/${m.checks} Checks${m.tools_leaked ? ` · ${m.tools_leaked} Tools zu viel` : ''}`;
    case 'smoke':
      return `${m.models_healthy}/${m.models_expected} Modelle ok`;
    case 'thinking':
      return `Genauigkeit ${m.accuracy_gain >= 0 ? '+' : ''}${fmt.num((m.accuracy_gain ?? 0) * 100, 0)} Pkt. · ${fmt.num(m.token_factor)}× Tokens`;
    default:
      return m.cases !== undefined ? `${m.passed}/${m.cases} Fälle` : '';
  }
}

const csv = (v) => (v ? v.split(',').filter(Boolean) : []);

// Historie: Testläufe als Bündel, aufklappbar zu den einzelnen Tests.
// Filter (Team/Nutzer, Endpoints und Modelle, Zeitraum) lassen sich über die URL vom Dashboard übernehmen.
export default function History() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(() => new Set());
  const [filtering, setFiltering] = useState(false);
  const scope = params.get('scope') ?? 'me'; // 'me' | 'all' | 'team:<id>'
  const selection = { models: csv(params.get('models')), endpoints: csv(params.get('endpoints')) };
  const selectedCount = selection.models.length + selection.endpoints.length;
  const page = Number(params.get('page') ?? 1);
  const teams = useApi(scope.startsWith('team:') ? '/api/teams' : null);
  const filters = useApi('/api/dashboard/filters');
  const query = new URLSearchParams({
    ...scopeParams(scope),
    page: String(page),
    pageSize: '20',
    status: params.get('status') ?? '',
    type: params.get('type') ?? '',
    search: params.get('search') ?? '',
    days: params.get('days') ?? '',
    models: params.get('models') ?? '',
    endpoints: params.get('endpoints') ?? '',
  });
  const history = useApi(`/api/history?${query}`, { interval: 10000 });

  function update(patch) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }
  const toggle = (id) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const totalPages = history.data ? Math.max(1, Math.ceil(history.data.total / history.data.pageSize)) : 1;
  const runs = history.data?.runs ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Historie</h1>
          <p>
            {scopeLabel(scope, user, teams.data ?? [])}. Jeder Testlauf mit den enthaltenen Tests; ein Klick auf einen Test öffnet die Details.
          </p>
        </div>
        <div className="btn-row">
          <ScopePicker value={scope} onChange={(v) => update({ scope: v })} />
          <button className={`btn${selectedCount ? ' primary' : ''}`} onClick={() => setFiltering(true)}>
            <ListFilter size={15} /> {selectedCount ? `${selection.endpoints.length} Endpoints, ${selection.models.length} Modelle` : 'Modelle und Endpoints'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <input placeholder="Suche nach Lauf, Test, Modell, Endpoint" defaultValue={params.get('search') ?? ''} onKeyDown={(e) => e.key === 'Enter' && update({ search: e.target.value })} />
          <select value={params.get('days') ?? ''} onChange={(e) => update({ days: e.target.value })} aria-label="Zeitraum">
            <option value="">Gesamter Zeitraum</option>
            <option value="7">Letzte 7 Tage</option>
            <option value="30">Letzte 30 Tage</option>
            <option value="90">Letzte 90 Tage</option>
          </select>
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
            {history.data?.total ?? 0} Läufe
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }} />
                <th>Gestartet</th>
                <th>Lauf</th>
                <th>Auslöser</th>
                <th>Status</th>
                <th className="num">Tests</th>
                <th className="num">Bestanden</th>
                <th className="num">Fehlgeschlagen</th>
                <th className="num">Dauer</th>
                {scope !== 'me' && <th>Nutzer</th>}
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const expanded = open.has(run.id);
                return (
                  <Fragment key={run.id}>
                    <tr className="clickable" onClick={() => toggle(run.id)} aria-expanded={expanded}>
                      <td>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                      <td className="sub" style={{ whiteSpace: 'nowrap' }}>
                        {fmt.date(run.created_at)}
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        <Link to={`/runs/${run.id}`} onClick={(e) => e.stopPropagation()}>
                          {run.label}
                        </Link>
                      </td>
                      <td>{{ manual: 'Manuell', schedule: 'Zeitplan', api: 'API' }[run.trigger] ?? run.trigger}</td>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="num">{run.total}</td>
                      <td className="num" style={{ color: run.passed ? 'var(--ok, #1a9b5f)' : undefined }}>
                        {run.passed}
                      </td>
                      <td className="num" style={{ color: run.failed + run.errored ? 'var(--bad, #dc2626)' : undefined }}>
                        {run.failed + run.errored}
                      </td>
                      <td className="num">{run.finished_at && run.started_at ? fmt.ms(new Date(run.finished_at) - new Date(run.started_at)) : '–'}</td>
                      {scope !== 'me' && <td>{run.user_name ?? 'Zeitplan'}</td>}
                    </tr>
                    {expanded &&
                      run.results.map((r) => (
                        <tr key={r.id} style={{ background: 'var(--surface-hover)' }}>
                          <td />
                          <td className="sub" style={{ whiteSpace: 'nowrap' }}>
                            {fmt.date(r.started_at)}
                          </td>
                          <td colSpan={2}>
                            <Link to={`/runs/${run.id}#${r.id}`} style={{ fontWeight: 600 }}>
                              {r.test_name}
                            </Link>
                            <div className="sub">
                              {TYPE_LABELS[r.type] ?? r.type} · {r.endpoint_name}
                              {r.model ? ` · ${r.model_alias ?? r.model}` : ''}
                              {r.api_key_name ? ` · Key ${r.api_key_name}` : ''}
                            </div>
                          </td>
                          <td>
                            <StatusBadge status={r.status} />
                            {r.regression && (
                              <span className="badge warn" style={{ marginLeft: 4 }} title="Schlechter als die letzte bestandene Ausführung">
                                <TrendingDown size={12} /> Regression
                              </span>
                            )}
                          </td>
                          <td className="num">{fmt.pct(r.score)}</td>
                          <td className="sub" colSpan={2}>
                            {r.error ? <span style={{ color: 'var(--bad)' }}>{r.error.slice(0, 100)}</span> : keyMetric(r)}
                          </td>
                          <td className="num">{fmt.ms(r.duration_ms)}</td>
                          {scope !== 'me' && <td />}
                        </tr>
                      ))}
                    {expanded && run.results.length === 0 && (
                      <tr>
                        <td />
                        <td colSpan={9} className="sub">
                          Noch keine Testergebnisse
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty">
                    Keine Testläufe gefunden
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
      {filtering && (
        <FilterDialog
          filters={filters.data ?? []}
          selection={selection}
          canDev={user.is_admin}
          onClose={() => setFiltering(false)}
          onApply={(next) => {
            update({ models: next.models.join(','), endpoints: next.endpoints.join(',') });
            setFiltering(false);
          }}
        />
      )}
    </>
  );
}
