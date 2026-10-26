import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Gauge, Percent, Play } from 'lucide-react';
import { DailyBars, ProgressList, TrendLines } from '../components/Charts.jsx';
import { api, can, Card, fmt, initials, StatusBadge, TYPE_LABELS, useApi, useUser } from '../lib.jsx';

export default function Dashboard() {
  const user = useUser();
  const navigate = useNavigate();
  const [scope, setScope] = useState('global');
  const [days, setDays] = useState(30);
  const { data, error } = useApi(`/api/dashboard?scope=${scope}&days=${days}`, { interval: 15000 });
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

  async function runAll() {
    const run = await api('/api/runs', { method: 'POST', body: { kind: 'all' } });
    navigate(`/runs/${run.id}`);
  }

  if (error) return <div className="error-box">{error}</div>;
  const k = data?.kpis ?? {};

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hallo {(user.display_name ?? user.username).split(' ')[0]}</h1>
          <p>
            {scope === 'global' ? 'Auswertung über alle Nutzer' : 'Deine eigenen Testläufe'} am {today}.
          </p>
        </div>
        <div className="btn-row">
          <div className="segmented" role="tablist" aria-label="Umfang">
            <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>
              Alle Nutzer
            </button>
            <button className={scope === 'me' ? 'active' : ''} onClick={() => setScope('me')}>
              Nur ich
            </button>
          </div>
          <select className="inline" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Zeitraum">
            <option value={7}>Letzte 7 Tage</option>
            <option value={30}>Letzte 30 Tage</option>
            <option value={90}>Letzte 90 Tage</option>
          </select>
          {can(user, 'tester') && (
            <button className="btn primary" onClick={runAll}>
              <Play size={15} /> Alle Tests ausführen
            </button>
          )}
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
          icon={<Gauge size={16} />}
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

      <div className="grid cols-2">
        <Card title="Erfolgsquote nach Testart" sub="Anteil bestandener Ergebnisse je Testtyp" action={<Link to="/tests">Zu den Tests</Link>}>
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

      <div className="grid cols-2-even">
        <Card title="Time-to-first-Token p95 je Modell" sub="Aus Performance-Tests, Tagesmittel">
          {perf.rows.length ? <TrendLines data={perf.rows} keys={perf.models} valueFormatter={fmt.ms} /> : <div className="empty">Noch keine Performance-Daten</div>}
        </Card>
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
        <Card title="Modelle im Vergleich" sub="Qualität, Sicherheit und Geschwindigkeit je Modell im Zeitraum" flush>
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
                  <tr key={m.model}>
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

      {scope === 'global' && (
        <Card title="Alle Nutzer" sub="Testaktivität je Nutzer im Zeitraum" flush>
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
    </>
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
