import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Square } from 'lucide-react';
import { TrendLines } from '../components/Charts.jsx';
import { api, can, Card, fmt, StatusBadge, TYPE_LABELS, useApi, useUser } from '../lib.jsx';

const ACTIVE = ['queued', 'running'];

export default function RunDetail() {
  const { id } = useParams();
  const user = useUser();
  const [interval, setIntervalMs] = useState(2000);
  const run = useApi(`/api/runs/${id}`, { interval });
  const logs = useRunLogs(id, interval);
  const isActive = run.data && ACTIVE.includes(run.data.status);

  useEffect(() => {
    if (run.data && !ACTIVE.includes(run.data.status)) setIntervalMs(undefined);
  }, [run.data]);

  async function cancel() {
    await api(`/api/runs/${id}/cancel`, { method: 'POST' });
    run.reload();
  }

  if (run.error) return <div className="error-box">{run.error}</div>;
  if (!run.data) return null;
  const r = run.data;

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/history" className="sub" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <ArrowLeft size={14} /> Meine Tests
          </Link>
          <h1 style={{ marginTop: 6 }}>{r.label}</h1>
          <p>
            <StatusBadge status={r.status} /> · gestartet {fmt.date(r.started_at ?? r.created_at)} von {r.user_name ?? 'Zeitplan'} · {r.passed}/
            {r.total} bestanden
          </p>
        </div>
        {isActive && can(user, 'tester') && (
          <button className="btn danger" onClick={cancel}>
            <Square size={14} /> Abbrechen
          </button>
        )}
      </div>

      {r.results.map((res) => (
        <ResultCard key={res.id} result={res} logs={logs.filter((l) => l.result_id === res.id)} />
      ))}
      {r.results.length === 0 && <div className="card empty">Lauf wartet auf einen freien Worker…</div>}

      <div style={{ marginTop: 24 }}>
        <Card title="Lauf-Log" sub="Alle Meldungen dieses Laufs" flush>
          <LogView logs={logs} />
        </Card>
      </div>
    </>
  );
}

function useRunLogs(runId, interval) {
  const [logs, setLogs] = useState([]);
  const last = useRef(0);
  useEffect(() => {
    last.current = 0;
    setLogs([]);
  }, [runId]);
  useEffect(() => {
    let stop = false;
    async function load() {
      const rows = await api(`/api/runs/${runId}/logs?after=${last.current}`).catch(() => []);
      if (stop || !rows.length) return;
      last.current = rows.at(-1).id;
      setLogs((l) => [...l, ...rows]);
    }
    load();
    if (!interval) return () => (stop = true);
    const t = setInterval(load, interval);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [runId, interval]);
  return logs;
}

function LogView({ logs }) {
  if (!logs.length) return <div className="empty">Noch keine Logeinträge</div>;
  return (
    <div className="log">
      {logs.map((l) => (
        <div key={l.id} className={l.level}>
          <time>{new Date(l.ts).toLocaleTimeString('de-DE')}</time>
          {l.message}
        </div>
      ))}
    </div>
  );
}

function ResultCard({ result, logs }) {
  const history = useApi(result.test_id && result.finished_at ? `/api/tests/${result.test_id}/history?limit=30` : null);
  const metrics = Object.entries(result.metrics ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
  const regression = result.details?.regression;
  const trendKey = ['ttft_ms_p95', 'latency_ms_p95', 'error_rate'].find((k) => typeof result.metrics?.[k] === 'number');
  const trend = (history.data ?? [])
    .slice()
    .reverse()
    .map((h) => ({ day: h.finished_at, Score: h.score, [trendKey]: h.metrics?.[trendKey] }));

  return (
    <div id={result.id} style={{ marginBottom: 20 }}>
      <Card
        title={result.test_name}
        sub={`${TYPE_LABELS[result.type] ?? result.type} · ${result.endpoint_name ?? ''}${result.model ? ` · ${result.model}` : ''}${result.persona_name ? ` · als ${result.persona_name}` : ''} · ${fmt.ms(result.duration_ms)}`}
        action={<StatusBadge status={result.status} />}
      >
        {result.error && <div className="error-box">{result.error}</div>}
        {metrics.length > 0 && (
          <div className="metric-grid" style={{ marginBottom: 16 }}>
            {result.score !== null && (
              <div className="metric">
                <div className="k">score</div>
                <div className="v">{fmt.pct(result.score)}</div>
              </div>
            )}
            {metrics.map(([k, v]) => (
              <div className="metric" key={k}>
                <div className="k">{k}</div>
                <div className="v">{formatMetric(k, v)}</div>
              </div>
            ))}
          </div>
        )}
        {regression?.regressions?.length > 0 && (
          <div className="error-box" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
            Regression gegenüber der letzten bestandenen Ausführung (Toleranz {fmt.pct(regression.tolerance)}):{' '}
            {regression.regressions.map((x) => `${x.metric} ${formatMetric(x.metric, x.baseline)} → ${formatMetric(x.metric, x.current)}`).join(', ')}
          </div>
        )}
        {trendKey && trend.length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 13, marginBottom: 8 }}>Verlauf {trendKey}</h2>
            <TrendLines data={trend} keys={[trendKey]} valueFormatter={(v) => formatMetric(trendKey, v)} height={180} />
          </div>
        )}
        <DetailsTable result={result} />
        <details style={{ marginTop: 12 }}>
          <summary className="sub">Rohdaten und Logs</summary>
          <pre className="json" style={{ marginTop: 8 }}>
            {JSON.stringify(result.details, null, 2)}
          </pre>
          <div style={{ marginTop: 8 }}>
            <LogView logs={logs} />
          </div>
        </details>
      </Card>
    </div>
  );
}

function formatMetric(key, v) {
  if (typeof v !== 'number') return v;
  if (key.includes('_ms')) return fmt.ms(v);
  if (key.includes('rate') || key.startsWith('score') || key.startsWith('pass_rate')) return fmt.pct(v);
  return fmt.num(v);
}

// Einzelfälle (Quality, Security, Access, MCP, Vergleich) als Tabelle.
function DetailsTable({ result }) {
  const d = result.details ?? {};
  if (d.ranking) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Modell</th>
              <th className="num">Score</th>
              <th className="num">Ø Latenz</th>
              <th className="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {d.ranking.map((m, i) => (
              <tr key={m.model}>
                <td>{i + 1}</td>
                <td style={{ fontWeight: 600 }}>{m.model}</td>
                <td className="num">{fmt.pct(m.score)}</td>
                <td className="num">{fmt.ms(m.latency_ms_avg)}</td>
                <td className="num">{m.tokens_total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (d.stages) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stufe</th>
              <th className="num">Parallel</th>
              <th className="num">Requests</th>
              <th className="num">req/s</th>
              <th className="num">Fehlerquote</th>
              <th className="num">p95</th>
            </tr>
          </thead>
          <tbody>
            {d.stages.map((s) => (
              <tr key={s.stage}>
                <td>{s.stage}</td>
                <td className="num">{s.concurrency}</td>
                <td className="num">{s.requests}</td>
                <td className="num">{fmt.num(s.requests_per_s)}</td>
                <td className="num">{fmt.pct(s.error_rate)}</td>
                <td className="num">{fmt.ms(s.latency_ms_p95)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const cases = d.cases ?? d.checks;
  if (!Array.isArray(cases) || !cases.length) {
    return d.violations?.length ? <div className="error-box">{d.violations.join(' · ')}</div> : null;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fall</th>
            <th>Ergebnis</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr key={i}>
              <td>
                <div style={{ fontWeight: 600 }}>{c.name ?? c.model}</div>
                <div className="sub">{[c.category, c.expect && `erwartet: ${c.expect}`].filter(Boolean).join(' · ')}</div>
              </td>
              <td>
                <StatusBadge status={c.ok ? 'passed' : 'failed'} />
              </td>
              <td className="sub" style={{ maxWidth: 520 }}>
                {c.error ??
                  [
                    c.status !== undefined && `HTTP ${c.status}`,
                    c.latencyMs !== undefined && fmt.ms(c.latencyMs),
                    c.blocked && 'vom Gateway blockiert',
                    c.leakedCanary && 'Geheimnis geleakt',
                    c.pii?.length && `PII: ${c.pii.join(', ')}`,
                    c.missing?.length && `fehlt: ${c.missing.join(', ')}`,
                    c.leaked?.length && `unerlaubt sichtbar: ${c.leaked.join(', ')}`,
                    c.outcomes?.map((o) => `${o.ok ? '✓' : '✕'} ${o.message}`).join(' · '),
                    c.notes?.join(' · '),
                    c.answer && `„${c.answer.slice(0, 140)}${c.answer.length > 140 ? '…' : ''}“`,
                    c.output && `„${c.output.slice(0, 140)}“`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
