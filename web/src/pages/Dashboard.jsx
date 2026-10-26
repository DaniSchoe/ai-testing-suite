import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Gauge as GaugeIcon, ListFilter, Percent, Table2 } from 'lucide-react';
import { DailyBars, Gauge, LoadScatter, ProgressList, RadarProfile, TrendLines } from '../components/Charts.jsx';
import FilterDialog from '../components/FilterDialog.jsx';
import { can, Card, fmt, initials, ScopePicker, scopeLabel, scopeParams, StatusBadge, TYPE_LABELS, useApi, useUser } from '../lib.jsx';
import { bestModels, profileAxes } from '../modelProfile.js';

export default function Dashboard() {
  const user = useUser();
  const navigate = useNavigate();
  const [scope, setScope] = useState(() => (can(user, 'results.view_all') ? 'all' : 'me'));
  const [days, setDays] = useState(30);
  const [selection, setSelection] = useState({ models: [], endpoints: [] });
  const [filtering, setFiltering] = useState(false);
  const query = new URLSearchParams({ ...scopeParams(scope), days: String(days) });
  if (selection.models.length) query.set('models', selection.models.join(','));
  if (selection.endpoints.length) query.set('endpoints', selection.endpoints.join(','));
  const filters = useApi('/api/dashboard/filters');
  const { data, error } = useApi(`/api/dashboard?${query}`, { interval: 15000 });
  const teams = useApi(scope.startsWith('team:') && can(user, 'results.view_all') ? '/api/teams' : null);
  const today = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

  const perf = useMemo(() => {
    const byDay = new Map();
    const models = new Set();
    for (const row of data?.perfByModel ?? []) {
      models.add(row.model);
      const entry = byDay.get(row.day) ?? { day: row.day };
      entry[row.model] = row.ttft_ms_p95;
      byDay.set(row.day, entry);
    }
    return { rows: [...byDay.values()], models: [...models] };
  }, [data]);

  // Ein Polygon je Modell, wie bei der TTFT-Ansicht; mehr als acht Modelle unterscheiden sich farblich nicht mehr.
  const radar = useMemo(() => (data?.profiles ?? []).slice(0, 8).map((m) => ({ name: m.model, axes: profileAxes(m) })), [data]);
  const best = useMemo(() => bestModels(data?.profiles), [data]);
  // Filter für die Folgeseiten (Historie, Modellprofil) übernehmen.
  const carry = new URLSearchParams({ scope, days: String(days) });
  if (selection.models.length) carry.set('models', selection.models.join(','));
  if (selection.endpoints.length) carry.set('endpoints', selection.endpoints.join(','));
  const selectedCount = selection.models.length + selection.endpoints.length;

  if (error) return <div className="error-box">{error}</div>;
  const k = data?.kpis ?? {};

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hallo {(user.display_name ?? user.username).split(' ')[0]}</h1>
          <p>
            {scopeLabel(scope, user, teams.data ?? [])} am {today}.
          </p>
        </div>
        <div className="btn-row">
          <ScopePicker value={scope} onChange={setScope} withTeams={false} />
          <select className="inline" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Zeitraum">
            <option value={7}>Letzte 7 Tage</option>
            <option value={30}>Letzte 30 Tage</option>
            <option value={90}>Letzte 90 Tage</option>
          </select>
          <button className={`btn${selectedCount ? ' primary' : ''}`} onClick={() => setFiltering(true)}>
            <ListFilter size={15} /> {selectedCount ? `${selection.endpoints.length} Endpoints, ${selection.models.length} Modelle` : 'Modelle und Endpoints'}
          </button>
        </div>
      </div>

      <div className="grid kpis">
        <Kpi
          title="Testläufe"
          icon={<Activity size={16} />}
          value={fmt.num(k.runs, 0)}
          sub={`${fmt.num(k.results, 0)} Testergebnisse · ${k.active ?? 0} aktiv`}
          to={`/history?${carry}`}
        />
        <Kpi
          title="Erfolgsquote"
          icon={<Percent size={16} />}
          value={fmt.pct(k.pass_rate)}
          sub={`${k.passed ?? 0} bestanden · ${(k.failed ?? 0) + (k.errored ?? 0)} nicht bestanden`}
        />
        <Kpi
          title="TTFT p95 (Ø)"
          icon={<GaugeIcon size={16} />}
          value={fmt.ms(k.ttft_ms_p95)}
          sub={`${fmt.num(k.tokens_per_s, 0)} Tokens/s · Security-Score ${fmt.pct(k.security_score)}`}
        />
        <Kpi
          title="Fehlschläge (24 h)"
          icon={<AlertTriangle size={16} />}
          tone="bad"
          value={fmt.num(k.failing_24h, 0)}
          sub={`${k.regressions ?? 0} Regressionen im Zeitraum`}
          subTone={k.regressions ? 'bad' : undefined}
        />
      </div>

      <div className="two-col">
        <Card title="Genauigkeit / Qualität" sub={`Ø Score aus Qualitäts- und Tool-Calling-Tests${data?.quality?.results ? ` (${data.quality.results} Ergebnisse)` : ''}`}>
          <div style={{ minHeight: 300, display: 'grid', placeItems: 'center' }}>
            <Gauge value={data?.quality?.score ?? null} label="Genauigkeit und Qualität" sub={data?.quality?.results ? 'Grün ab 80 %, gelb ab 60 %' : 'Noch keine Qualitätsdaten im Zeitraum'} />
          </div>
        </Card>
        <Card
          title={
            <Link to={`/model-profiles?${carry}`} className="title-link">
              Modellprofil <Table2 size={15} style={{ verticalAlign: -2 }} />
            </Link>
          }
          sub="Ein Netz je Modell, alle Achsen von 0 bis 100, höher ist besser"
          action={
            <Link className="btn sm" to={`/model-profiles?${carry}`}>
              Details
            </Link>
          }
        >
          {radar.length ? <RadarProfile series={radar} /> : <div className="empty">Keine Modelldaten im Zeitraum</div>}
        </Card>
      </div>

      <div className="grid kpis">
        {best.map((b) => (
          <section className="card kpi" key={b.key}>
            <div className="kpi-top">
              <span>Bestes Modell: {b.title}</span>
            </div>
            <div className="kpi-value" style={{ fontSize: 22, overflowWrap: 'anywhere' }}>
              {b.model ?? '–'}
            </div>
            <div className="kpi-sub">
              <strong>{b.score}</strong> · {b.detail}
            </div>
          </section>
        ))}
      </div>

      <div className="two-col">
        <Card title="Last: Antwortzeit und parallele Anfragen" sub="p95 je Laststufe aus den Lasttests im Zeitraum">
          {data?.loadPoints?.length ? <LoadScatter points={data.loadPoints} /> : <div className="empty">Noch keine Lasttests im Zeitraum</div>}
        </Card>
        <Card title="Time-to-first-Token p95 je Modell" sub="Aus Performance-Tests, Tagesmittel">
          {perf.rows.length ? <TrendLines data={perf.rows} keys={perf.models} valueFormatter={fmt.ms} /> : <div className="empty">Noch keine Performance-Daten</div>}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Erfolgsquote nach Testart" sub="Anteil bestandener Ergebnisse je Testtyp" action={<Link to="/test-builder">Zum Test-Builder</Link>}>
          {data?.byType?.length ? (
            <ProgressList
              rows={data.byType.map((t) => ({
                label: TYPE_LABELS[t.type] ?? t.type,
                count: t.total,
                value: t.total ? t.passed / t.total : 0,
                valueLabel: fmt.pct(t.total ? t.passed / t.total : null),
              }))}
            />
          ) : (
            <div className="empty">Noch keine Ergebnisse im Zeitraum</div>
          )}
        </Card>
        <Card title="Ergebnisse pro Tag" sub={`Letzte ${days} Tage`}>
          <DailyBars
            data={data?.trend ?? []}
            series={[
              { key: 'passed', label: 'Bestanden', color: 'var(--bar)' },
              { key: 'failed', label: 'Fehlgeschlagen', color: 'var(--series-8)' },
              { key: 'errored', label: 'Fehler', color: 'var(--series-4)' },
            ]}
          />
        </Card>
      </div>

      <div style={{ marginBottom: 24 }}>
        <Card title="Letzte Fehlschläge" sub="Die neuesten zuerst" action={<Link to="/history?status=failed">Alle</Link>} flush>
          {data?.recentFailures?.length ? (
            <table>
              <tbody>
                {data.recentFailures.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => navigate(`/runs/${f.run_id}`)}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{f.test_name}</div>
                      <div className="sub">
                        {TYPE_LABELS[f.type]} · {f.model ?? '–'} · {f.user_name ?? 'Zeitplan'}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={f.status} />
                    </td>
                    <td className="num sub">{fmt.ago(f.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">Keine Fehlschläge im Zeitraum</div>
          )}
        </Card>
      </div>

      {data?.thinking?.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <Card title="Thinking vs. Non-Thinking" sub="Mittelwerte aus Thinking-Tests im Zeitraum: was bringt Reasoning und was kostet es?" flush>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Modell</th>
                    <th className="num">Tests</th>
                    <th className="num">Genauigkeit mit Thinking</th>
                    <th className="num">Gewinn ggü. ohne</th>
                    <th className="num">Token-Faktor</th>
                    <th className="num">Latenz-Faktor</th>
                  </tr>
                </thead>
                <tbody>
                  {data.thinking.map((t) => (
                    <tr key={t.model}>
                      <td style={{ fontWeight: 600 }}>{t.model}</td>
                      <td className="num">{t.results}</td>
                      <td className="num">{fmt.pct(t.thinking_accuracy)}</td>
                      <td className="num">
                        {t.accuracy_gain === null ? '–' : `${t.accuracy_gain >= 0 ? '+' : ''}${fmt.num(t.accuracy_gain * 100, 0)} Pkt.`}
                      </td>
                      <td className="num">{t.token_factor === null ? '–' : `${fmt.num(t.token_factor)}×`}</td>
                      <td className="num">{t.latency_factor === null ? '–' : `${fmt.num(t.latency_factor)}×`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {scope !== 'me' && (
        <Card title={scope === 'all' ? 'Alle Nutzer' : 'Teammitglieder'} sub="Testaktivität je Nutzer im Zeitraum" flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nutzer</th>
                  <th className="num">Läufe</th>
                  <th className="num">Ergebnisse</th>
                  <th className="num">Erfolgsquote</th>
                  <th className="num">Letzter Lauf</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byUser ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                        <span className="avatar sm">{initials(u.display_name ?? u.username)}</span>
                        {u.display_name ?? u.username}
                      </span>
                    </td>
                    <td className="num">{u.runs}</td>
                    <td className="num">{u.results}</td>
                    <td className="num">{fmt.pct(u.pass_rate)}</td>
                    <td className="num">{fmt.ago(u.last_run_at)}</td>
                  </tr>
                ))}
                {!data?.byUser?.length && (
                  <tr>
                    <td colSpan={5} className="empty">
                      Noch keine Läufe
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {filtering && (
        <FilterDialog
          filters={filters.data ?? []}
          selection={selection}
          canDev={user.is_admin}
          onClose={() => setFiltering(false)}
          onApply={(next) => {
            setSelection(next);
            setFiltering(false);
          }}
        />
      )}
    </>
  );
}

function Kpi({ title, icon, value, sub, tone, subTone, to }) {
  const Wrapper = to ? Link : 'section';
  return (
    <Wrapper className={`card kpi${to ? ' kpi-link' : ''}`} {...(to ? { to, title: 'Zur Historie' } : {})}>
      <div className="kpi-top">
        <span>{title}</span>
        <span className={`kpi-icon${tone ? ` ${tone}` : ''}`}>{icon}</span>
      </div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-sub${subTone ? ` ${subTone}` : ''}`}>{sub}</div>
    </Wrapper>
  );
}
