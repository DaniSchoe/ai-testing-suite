import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Sparkles, Square } from 'lucide-react';
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

  // Polling endet, wenn der Lauf fertig ist und auch die KI-Analyse nicht mehr erstellt wird.
  useEffect(() => {
    if (run.data) setIntervalMs(ACTIVE.includes(run.data.status) || run.data.analysis_status === 'pending' ? 2000 : undefined);
  }, [run.data]);

  async function regenerate() {
    await api(`/api/runs/${id}/analysis`, { method: 'POST' });
    run.reload();
  }

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
            <ArrowLeft size={14} /> Historie
          </Link>
          <h1 style={{ marginTop: 6 }}>{r.label}</h1>
          <p>
            <StatusBadge status={r.status} /> · gestartet {fmt.date(r.started_at ?? r.created_at)} von {r.user_name ?? 'Zeitplan'} · {r.passed}/
            {r.total} bestanden
          </p>
        </div>
        {isActive && (r.user_id === user.id ? can(user, 'runs.start') : can(user, 'runs.manage_all')) && (
          <button className="btn danger" onClick={cancel}>
            <Square size={14} /> Abbrechen
          </button>
        )}
      </div>

      {!isActive && r.results.length > 0 && <AnalysisCard run={r} onRegenerate={can(user, 'runs.start') ? regenerate : null} />}

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

// KI-Analyse des Laufs: Bewertung, Einordnung und Zusammenfassung durch das im Modellkatalog gewählte Modell.
function AnalysisCard({ run, onRegenerate }) {
  const a = run.analysis;
  const pending = run.analysis_status === 'pending';
  return (
    <div style={{ marginBottom: 20 }}>
      <Card
        title={
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Sparkles size={16} /> KI-Analyse
          </span>
        }
        sub={a?.model ? `Erstellt mit ${a.model}${a.endpoint ? ` über ${a.endpoint}` : ''}${a.generated_at ? ` · ${fmt.ago(a.generated_at)}` : ''}` : 'Bewertung, Einordnung und Zusammenfassung des Laufs'}
        action={
          onRegenerate && (
            <button className="btn sm" onClick={onRegenerate} disabled={pending}>
              <RefreshCw size={13} /> {pending ? 'Wird erstellt…' : 'Neu erstellen'}
            </button>
          )
        }
      >
        {pending && <div className="sub">Die Analyse wird erstellt…</div>}
        {!pending && run.analysis_status === 'error' && <div className="error-box">Die Analyse ist fehlgeschlagen: {a?.error}</div>}
        {!pending && run.analysis_status === 'skipped' && (
          <div className="sub">Es ist noch kein Modell für die KI-Analyse festgelegt. Das geht im Modellkatalog; danach lässt sich die Analyse hier neu erstellen.</div>
        )}
        {!pending && !run.analysis_status && <div className="sub">Für diesen Lauf gibt es keine Analyse.</div>}
        {!pending && run.analysis_status === 'done' && a?.text && <Markdown text={a.text} />}
      </Card>
    </div>
  );
}

// Kleiner Markdown-Renderer für die Analyse: Überschriften, Listen, Fettdruck. Alles wird als Text ausgegeben, nie als HTML.
function Markdown({ text }) {
  const inline = (line) =>
    line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
  const blocks = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (!list) blocks.push((list = { type: 'ul', items: [] }));
      list.items.push(bullet[1]);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(heading ? { type: 'h', text: heading[1] } : { type: 'p', text: line });
  }
  return (
    <div className="analysis">
      {blocks.map((b, i) =>
        b.type === 'h' ? (
          <h3 key={i} style={{ fontSize: 14, margin: '14px 0 6px' }}>
            {inline(b.text)}
          </h3>
        ) : b.type === 'ul' ? (
          <ul key={i} className="steps" style={{ margin: '0 0 6px' }}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <p key={i} style={{ margin: '0 0 8px' }}>
            {inline(b.text)}
          </p>
        ),
      )}
    </div>
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
        sub={`${TYPE_LABELS[result.type] ?? result.type} · ${result.endpoint_name ?? ''}${result.model ? ` · ${result.model}` : ''}${result.api_key_name ? ` · mit Key ${result.api_key_name}` : ''} · ${fmt.ms(result.duration_ms)}`}
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
  if (key.includes('rate') || key.startsWith('score') || key.startsWith('pass_rate') || key.startsWith('accuracy') || key.startsWith('judge_score')) {
    return fmt.pct(v);
  }
  if (key.endsWith('_factor')) return `${fmt.num(v)}×`;
  return fmt.num(v);
}

// Einzelfälle (Quality, Coding, OCR, Security, Access, MCP) als Tabelle.
function DetailsTable({ result }) {
  const d = result.details ?? {};
  if (d.variants) return <ThinkingDetails variants={d.variants} />;
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
              <th className="num">davon 429</th>
              <th>p95 nach Schwierigkeit</th>
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
                <td className="num">{s.rate_limited ?? 0}</td>
                <td className="sub">
                  {Object.entries(s.by_difficulty ?? {})
                    .map(([level, v]) => `${level} ${fmt.ms(v.latency_ms_p95)}`)
                    .join(' · ')}
                </td>
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

// Thinking vs. Non-Thinking: Varianten nebeneinander, darunter jede Aufgabe je Variante.
function ThinkingDetails({ variants }) {
  const caseNames = variants[0]?.cases.map((c) => c.name) ?? [];
  return (
    <>
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Variante</th>
              <th className="num">Genauigkeit</th>
              <th className="num">Ø Latenz</th>
              <th className="num">Ø Tokens</th>
              <th className="num">Ø Reasoning</th>
              <th className="num">Tokens je richtige Antwort</th>
              <th className="num">Schlüssigkeit (Judge)</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr key={v.name}>
                <td>
                  <div style={{ fontWeight: 600 }}>{v.name}</div>
                  <div className="sub">
                    <code>{JSON.stringify(v.params)}</code>
                  </div>
                </td>
                <td className="num">
                  {fmt.pct(v.accuracy)} <span className="sub">({v.correct}/{v.cases.length})</span>
                </td>
                <td className="num">{fmt.ms(v.latency_ms_avg)}</td>
                <td className="num">{fmt.num(v.completion_tokens_avg, 0)}</td>
                <td className="num">{fmt.num(v.reasoning_tokens_avg, 0)}</td>
                <td className="num">{fmt.num(v.tokens_per_correct, 0)}</td>
                <td className="num">{fmt.pct(v.judge_score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Aufgabe</th>
              {variants.map((v) => (
                <th key={v.name}>{v.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {caseNames.map((name, i) => (
              <tr key={name}>
                <td style={{ fontWeight: 600 }}>{name}</td>
                {variants.map((v) => {
                  const c = v.cases[i];
                  return (
                    <td key={v.name} className="sub">
                      <StatusBadge status={c?.ok ? 'passed' : 'failed'} /> {c?.error ?? `${c?.answer?.slice(0, 60) ?? ''} · ${fmt.num(c?.completionTokens, 0)} Tokens · ${fmt.ms(c?.latencyMs)}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
