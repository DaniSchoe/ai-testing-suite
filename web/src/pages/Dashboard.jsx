import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Gauge as GaugeIcon, ListFilter, Percent } from 'lucide-react';
import { DailyBars, Gauge, LoadScatter, ProgressList, RadarProfile, TrendLines } from '../components/Charts.jsx';
import { can, Card, EnvBadge, fmt, initials, KindBadge, Modal, ScopePicker, scopeLabel, scopeParams, StatusBadge, TYPE_LABELS, useApi, useUser } from '../lib.jsx';

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

  const axes = useMemo(() => radarAxes(data?.radar), [data]);
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
          <ScopePicker value={scope} onChange={setScope} />
          <select className="inline" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Zeitraum">
            <option value={7}>Letzte 7 Tage</option>
            <option value={30}>Letzte 30 Tage</option>
            <option value={90}>Letzte 90 Tage</option>
          </select>
          <button className={`btn${selectedCount ? ' primary' : ''}`} onClick={() => setFiltering(true)}>
            <ListFilter size={15} /> {selectedCount ? `${selection.endpoints.length} Endpoints, ${selection.models.length} Modelle` : 'Modelle und Endpoints'}
          </button>
          <Link className="btn" to="/history">
            Alle Ergebnisse
          </Link>
        </div>
      </div>

      <div className="grid kpis">
        <Kpi title="Testläufe" icon={<Activity size={16} />} value={fmt.num(k.runs, 0)} sub={`${fmt.num(k.results, 0)} Testergebnisse · ${k.active ?? 0} aktiv`} />
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
          <Gauge value={data?.quality?.score ?? null} label="Genauigkeit und Qualität" sub={data?.quality?.results ? 'Grün ab 80 %, gelb ab 60 %' : 'Noch keine Qualitätsdaten im Zeitraum'} />
        </Card>
        <Card title="Modellprofil" sub="Alle Achsen von 0 bis 100, höher ist besser (Thinking-Anteil: Anteil der Reasoning-Tokens)">
          <RadarProfile axes={axes} />
        </Card>
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

      <div style={{ marginBottom: 24 }}>
        <Card title="Modelle im Vergleich" sub="Qualität, Sicherheit und Geschwindigkeit je Modell im Zeitraum. Ein Klick öffnet die Detailseite (Beta)." flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Modell</th>
                  <th className="num">Ergebnisse</th>
                  <th className="num">Erfolgsquote</th>
                  <th className="num">Qualität</th>
                  <th className="num">Security</th>
                  <th className="num">TTFT p95</th>
                  <th className="num">Tokens/s</th>
                </tr>
              </thead>
              <tbody>
                {(data?.models ?? []).map((m) => (
                  <tr key={m.model} className="clickable" onClick={() => navigate(`/models/${encodeURIComponent(m.model)}`)} title="Modelldetails (Beta)">
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.model}</div>
                      {m.endpoints > 1 && <div className="sub">über {m.endpoints} Endpoints</div>}
                    </td>
                    <td className="num">{m.results}</td>
                    <td className="num">{fmt.pct(m.pass_rate)}</td>
                    <td className="num">{fmt.pct(m.quality_score)}</td>
                    <td className="num">{fmt.pct(m.security_score)}</td>
                    <td className="num">{fmt.ms(m.ttft_ms_p95)}</td>
                    <td className="num">{fmt.num(m.tokens_per_s, 0)}</td>
                  </tr>
                ))}
                {!data?.models?.length && (
                  <tr>
                    <td colSpan={7} className="empty">
                      Keine Modelldaten im Zeitraum
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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

// Netzdiagramm: Rohwerte auf 0 bis 100 abbilden (höher ist besser).
const decay = (v, ref) => (v == null ? null : 100 / (1 + Number(v) / ref));
function radarAxes(r = {}) {
  const defs = [
    ['Antwortzeit', decay(r.latency_ms, 2000), fmt.ms(r.latency_ms)],
    ['Thinking-Anteil', r.thinking_share == null ? null : Number(r.thinking_share) * 100, fmt.pct(r.thinking_share == null ? null : Number(r.thinking_share))],
    ['TTFT', decay(r.ttft_ms, 500), fmt.ms(r.ttft_ms)],
    ['Qualität', r.quality == null ? null : Number(r.quality) * 100, fmt.pct(r.quality == null ? null : Number(r.quality))],
    ['Last-Performance', r.load_score == null ? null : Number(r.load_score) * 100, fmt.pct(r.load_score)],
    ['Tokens/s', r.tokens_per_s == null ? null : (100 * Number(r.tokens_per_s)) / (Number(r.tokens_per_s) + 30), `${fmt.num(r.tokens_per_s, 0)} Tokens/s`],
  ];
  return defs.map(([label, value, display]) => ({ label, value: value ?? 0, display: value == null ? '–' : display, missing: value == null }));
}

// Auswahl von Modellen und ganzen Endpoints; mehrere Einträge werden im Dashboard summiert.
function FilterDialog({ filters, selection, canDev, onClose, onApply }) {
  const [models, setModels] = useState(new Set(selection.models));
  const [endpoints, setEndpoints] = useState(new Set(selection.endpoints));
  const [text, setText] = useState('');
  const toggle = (set, setter, key) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    setter(next);
  };
  const match = (v) => v.toLowerCase().includes(text.toLowerCase());
  const list = filters.filter((f) => match(f.name) || f.models.some((m) => match(m.alias)));
  return (
    <Modal
      title="Modelle und Endpoints"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => onApply({ models: [], endpoints: [] })}>
            Zurücksetzen
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={() => onApply({ models: [...models], endpoints: [...endpoints] })}>
            Übernehmen
          </button>
        </>
      }
    >
      <div className="hint" style={{ marginBottom: 10 }}>
        Ohne Auswahl zeigt das Dashboard alle produktiven Modelle und Endpoints{canDev ? ' (Dev lässt sich hier gezielt dazuwählen)' : ''}. Mit Auswahl werden die
        gewählten Modelle und Endpoints zusammengefasst.
      </div>
      <input type="search" placeholder="Filtern…" value={text} onChange={(e) => setText(e.target.value)} style={{ marginBottom: 10 }} />
      <div className="pick-list" style={{ maxHeight: 380 }}>
        {list.map((f) => (
          <div key={f.id}>
            <label>
              <input type="checkbox" checked={endpoints.has(f.id)} onChange={() => toggle(endpoints, setEndpoints, f.id)} />
              <span style={{ fontWeight: 600 }}>
                {f.name} <KindBadge kind={f.kind} flavor={f.llm_flavor} /> <EnvBadge env={f.environment} />
              </span>
            </label>
            {f.models
              .filter((m) => !text || match(m.alias) || match(f.name))
              .map((m) => (
                <label key={m.name} style={{ paddingLeft: 34 }}>
                  <input type="checkbox" checked={models.has(m.alias)} onChange={() => toggle(models, setModels, m.alias)} />
                  <span>
                    {m.alias} {m.environment === 'dev' && <EnvBadge env="dev" />}
                  </span>
                </label>
              ))}
          </div>
        ))}
        {list.length === 0 && <div className="empty">Nichts gefunden</div>}
      </div>
    </Modal>
  );
}

function Kpi({ title, icon, value, sub, tone, subTone }) {
  return (
    <section className="card kpi">
      <div className="kpi-top">
        <span>{title}</span>
        <span className={`kpi-icon${tone ? ` ${tone}` : ''}`}>{icon}</span>
      </div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-sub${subTone ? ` ${subTone}` : ''}`}>{sub}</div>
    </section>
  );
}
