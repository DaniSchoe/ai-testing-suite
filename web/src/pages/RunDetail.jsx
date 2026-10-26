import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, RefreshCw, ShieldCheck, Sparkles, Square } from 'lucide-react';
import {
  api,
  can,
  Card,
  EnvBadge,
  ErrorBox,
  fmt,
  Loading,
  OUTCOME_LABELS,
  OutcomeBadge,
  PageHead,
  PATH_LABELS,
  StatusBadge,
  Tabs,
  TYPE_LABELS,
  useAction,
  useApi,
  useUser,
} from '../lib.jsx';

const ACTIVE = ['queued', 'running'];

export default function RunDetail() {
  const { id } = useParams();
  const user = useUser();
  const [interval, setIntervalMs] = useState(2000);
  const run = useApi(`/api/runs/${id}`, { interval });
  const logs = useRunLogs(id, interval);
  const [tab, setTab] = useState('results');
  const [act, error] = useAction();
  const isActive = run.data && ACTIVE.includes(run.data.status);

  // Polling endet, wenn der Lauf fertig ist und auch die KI-Analyse nicht mehr erstellt wird.
  useEffect(() => {
    if (run.data) setIntervalMs(ACTIVE.includes(run.data.status) || run.data.analysis_status === 'pending' ? 2000 : undefined);
  }, [run.data]);

  const regenerate = () =>
    act(async () => {
      await api(`/api/runs/${id}/analysis`, { method: 'POST' });
      run.reload();
    });
  const cancel = () =>
    act(async () => {
      await api(`/api/runs/${id}/cancel`, { method: 'POST' });
      run.reload();
    });

  return (
    <Loading state={run}>
      {(r) => (
        <>
          <PageHead
            title={
              <>
                {r.label} {r.is_draft && <span className="badge warn">Testlauf</span>}
              </>
            }
            action={
              <div className="btn-row">
                {r.report && (
                  <Link className="btn" to={`/reports/${r.report.id}`}>
                    <FileText size={15} /> Bericht
                  </Link>
                )}
                {isActive && (r.user_id === user.id ? can(user, 'runs.start') : can(user, 'runs.manage_all')) && (
                  <button className="btn danger" onClick={cancel}>
                    <Square size={14} /> Abbrechen
                  </button>
                )}
              </div>
            }
          >
            <Link to="/runs" className="sub">
              <ArrowLeft size={13} /> Läufe
            </Link>{' '}
            · <StatusBadge status={r.status} /> · {r.platform_name} {r.platform_environment && <EnvBadge env={r.platform_environment} />} · gestartet{' '}
            {fmt.date(r.started_at ?? r.created_at)} von {r.user_name ?? 'Zeitplan'}
          </PageHead>
          <ErrorBox error={error} />
          <Gate run={r} />
          {r.is_draft && <div className="hint">Dieser Testlauf zählt nicht in Läufen, Dashboard oder Berichten.</div>}
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['results', `Ergebnisse (${r.results.length})`],
              ['evidence', 'Nachweise'],
              ['snapshot', 'Snapshot'],
              ['log', 'Log'],
            ]}
          />
          {tab === 'results' && (
            <>
              {!isActive && r.results.length > 0 && <AnalysisCard run={r} onRegenerate={can(user, 'runs.start') ? regenerate : null} />}
              {r.comparison && <Comparison comparison={r.comparison} />}
              <Results run={r} logs={logs} />
              {r.results.length === 0 && <div className="card empty">Lauf wartet auf einen freien Worker…</div>}
            </>
          )}
          {tab === 'evidence' && <Evidence runId={id} hash={r.evidence_hash} />}
          {tab === 'snapshot' && <Snapshot snapshot={r.snapshot} />}
          {tab === 'log' && (
            <Card title="Lauf-Log" sub="Alle Meldungen dieses Laufs" flush>
              <LogView logs={logs} />
            </Card>
          )}
        </>
      )}
    </Loading>
  );
}

function Gate({ run }) {
  const g = run.gate;
  const outcomes = Object.entries(run.outcomes ?? {});
  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <div className="btn-row">
          {outcomes.map(([k, n]) => (
            <span key={k} className="btn-row" style={{ gap: 4 }}>
              <strong>{n}</strong> <OutcomeBadge outcome={k} />
            </span>
          ))}
          {outcomes.length === 0 && <span className="sub">Noch keine Ergebnisse</span>}
        </div>
        {g?.finished && (
          <span className={`badge ${g.pass ? 'passed' : 'failed'}`} title={`Gate lässt scheitern bei: ${(g.fail_on ?? []).map((x) => OUTCOME_LABELS[x] ?? x).join(', ')}`}>
            Gate: {g.pass ? 'bestanden' : 'nicht bestanden'}
          </span>
        )}
      </div>
      {g?.reasons?.length > 0 && (
        <ul className="sub" style={{ margin: '8px 0 0 16px' }}>
          {g.reasons.map((x, i) => (
            <li key={i}>{typeof x === 'string' ? x : x.message ?? JSON.stringify(x)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Comparison({ comparison }) {
  return (
    <Card title="Vergleich A/B" sub={comparison.kind === 'paths' ? 'Direkt gegen Gateway' : 'Modell A gegen Modell B'} flush>
      <table>
        <thead>
          <tr>
            <th>Vorlage</th>
            <th>A</th>
            <th>B</th>
            <th>Unterschiede</th>
          </tr>
        </thead>
        <tbody>
          {comparison.items.map((it, i) => (
            <tr key={i}>
              <td>{it.name?.split(' · ')[0]}</td>
              <td>
                {it.a.model} <span className="sub">{PATH_LABELS[it.a.path] ?? it.a.path}</span>
                <div>{it.a.score === null ? '–' : fmt.pct(it.a.score)}</div>
              </td>
              <td>
                {it.b.model} <span className="sub">{PATH_LABELS[it.b.path] ?? it.b.path}</span>
                <div>{it.b.score === null ? '–' : fmt.pct(it.b.score)}</div>
              </td>
              <td className="sub">
                {Object.entries(it.diff)
                  .filter(([, d]) => d.delta)
                  .map(([k, d]) => `${k}: ${formatMetric(k, d.a)} → ${formatMetric(k, d.b)}`)
                  .join(' · ') || 'keine'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Results({ run, logs }) {
  const [open, setOpen] = useState(null);
  if (!run.results.length) return null;
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Vorlage</th>
            <th>Modell · Pfad</th>
            <th>Ergebnis</th>
            <th className="num">Score</th>
            <th>Kennzahlen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {run.results.map((x) => (
            <ResultRows key={x.id} result={x} open={open === x.id} onToggle={() => setOpen(open === x.id ? null : x.id)} logs={logs.filter((l) => l.result_id === x.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KEY_METRICS = ['latency_ms_p95', 'ttft_ms_p95', 'tokens_per_s_avg', 'error_rate', 'false_allow', 'pass_rate'];

function ResultRows({ result: x, open, onToggle, logs }) {
  const violations = x.details?.thresholds?.violations ?? [];
  const regressions = x.details?.regression?.regressions ?? [];
  const ci = x.statistics?.score?.ci95 ?? x.statistics?.cases?.ci95;
  const shown = KEY_METRICS.filter((k) => typeof x.metrics?.[k] === 'number').slice(0, 3);
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td style={{ minWidth: 220 }}>
          <div style={{ fontWeight: 600 }}>{x.test_name.split(' · ')[0]}</div>
          <div className="sub">
            {TYPE_LABELS[x.type] ?? x.type} {x.template_version && <span className="mono">{x.template_version}</span>}
            {x.variant && ` · Variante ${x.variant}`}
          </div>
        </td>
        <td>
          {x.model_alias ?? x.model ?? '–'}
          <div className="sub">{PATH_LABELS[x.path] ?? x.path ?? ''}</div>
        </td>
        <td>
          <OutcomeBadge outcome={x.outcome ?? (x.status === 'passed' ? 'passed' : 'technical_error')} />
          {regressions.length > 0 && <span className="badge warn" style={{ marginLeft: 4 }}>Regression</span>}
          {x.statistics?.small_sample && <span className="badge warn" style={{ marginLeft: 4 }} title={`Weniger als ${x.statistics.min_cases} Fälle`}>kleine Stichprobe</span>}
        </td>
        <td className="num">
          {x.score === null ? '–' : fmt.pct(x.score)}
          {ci && <div className="sub">{`${fmt.pct(ci[0])} – ${fmt.pct(ci[1])}`}</div>}
          {x.statistics?.n > 1 && <div className="sub">Median aus {x.statistics.n}</div>}
        </td>
        <td className="sub">{shown.map((k) => `${k}: ${formatMetric(k, x.metrics[k])}`).join(' · ')}</td>
        <td className="sub">{open ? '▾' : '▸'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--surface-2, transparent)' }}>
            <ResultDetail result={x} violations={violations} regressions={regressions} logs={logs} />
          </td>
        </tr>
      )}
    </>
  );
}

function ResultDetail({ result: x, violations, regressions, logs }) {
  const metrics = Object.entries(x.metrics ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
  const d = x.details?.dataset;
  return (
    <div style={{ padding: 8 }}>
      {x.error && <div className="error-box">{x.error}</div>}
      {x.outcome === 'not_applicable' && <div className="hint">Nicht anwendbar: {x.error ?? 'Voraussetzung des Modells nicht erfüllt'}.</div>}
      {violations.length > 0 && (
        <div className="error-box">
          Schwellwerte verletzt:
          {violations.map((v, i) => (
            <div key={i}>{v.message}</div>
          ))}
        </div>
      )}
      {regressions.length > 0 && (
        <div className="error-box" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
          Regression gegenüber der Baseline (Toleranz {fmt.pct(x.details.regression.tolerance)}):{' '}
          {regressions.map((r) => `${r.metric} ${formatMetric(r.metric, r.baseline)} → ${formatMetric(r.metric, r.current)}`).join(', ')}{' '}
          <Link to={`/runs/${x.details.regression.baselineRunId}`}>Baseline-Lauf</Link>
        </div>
      )}
      {d && (
        <div className="sub" style={{ marginBottom: 8 }}>
          Datensatz {d.name ?? d.key} <span className="mono">{d.version}</span> · {d.cases} Fälle · Hash <span className="mono">{d.hash?.slice(0, 12)}</span>
          {d.small_sample && ` · unter der Mindestzahl von ${d.min_cases} Fällen`}
        </div>
      )}
      {metrics.length > 0 && (
        <div className="metric-grid" style={{ marginBottom: 12 }}>
          {metrics.map(([k, v]) => (
            <div className="metric" key={k}>
              <div className="k">
                {k}
                {x.statistics?.metrics?.[k] && x.statistics.n > 1 && (
                  <span title="Streuung über die Wiederholungen">
                    {' '}
                    ({formatMetric(k, x.statistics.metrics[k].min)}–{formatMetric(k, x.statistics.metrics[k].max)})
                  </span>
                )}
              </div>
              <div className="v">{formatMetric(k, v)}</div>
            </div>
          ))}
        </div>
      )}
      <DetailsTable result={x} />
      <details style={{ marginTop: 12 }}>
        <summary className="sub">Rohdaten und Logs</summary>
        <pre className="json" style={{ marginTop: 8 }}>
          {JSON.stringify(x.details, null, 2)}
        </pre>
        <div style={{ marginTop: 8 }}>
          <LogView logs={logs} />
        </div>
      </details>
    </div>
  );
}

function Evidence({ runId, hash }) {
  const evidence = useApi(`/api/runs/${runId}/evidence`);
  const [verify, setVerify] = useState(null);
  const [act, error, busy] = useAction();
  const check = () => act(async () => setVerify(await api(`/api/runs/${runId}/evidence/verify`)));
  return (
    <Card
      title="Nachweise"
      sub={hash ? `Kettenhash ${hash.slice(0, 24)}…` : 'Noch nicht versiegelt (Lauf läuft oder ist ein Testlauf)'}
      action={
        hash && (
          <button className="btn sm" onClick={check} disabled={busy}>
            <ShieldCheck size={13} /> Integrität prüfen
          </button>
        )
      }
    >
      <ErrorBox error={error} />
      {verify && (
        <div className={verify.ok ? 'hint' : 'error-box'}>
          {verify.ok ? `Integrität bestätigt (${verify.checked ?? verify.count ?? ''} Nachweise).` : `Abweichung festgestellt: ${verify.reason ?? JSON.stringify(verify)}`}
        </div>
      )}
      <Loading state={evidence}>
        {(e) =>
          e.items.length === 0 ? (
            <div className="empty">Keine Nachweise</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fall</th>
                    <th>Ergebnis</th>
                    <th>Prompt / Antwort</th>
                    <th>Hash</th>
                    <th>Aufbewahrung</th>
                  </tr>
                </thead>
                <tbody>
                  {e.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.case_key}</td>
                      <td>
                        <StatusBadge status={it.ok ? 'passed' : 'failed'} />
                      </td>
                      <td className="sub" style={{ maxWidth: 480, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {it.masked ? 'Angriffsinhalt maskiert (Berechtigung security.payloads erforderlich)' : it.purged_at ? 'Nach Ablauf der Aufbewahrung gelöscht' : `${(it.prompt ?? '').slice(0, 200)}${it.response ? `\n→ ${it.response.slice(0, 200)}` : ''}`}
                      </td>
                      <td className="mono sub">{it.hash.slice(0, 10)}</td>
                      <td className="sub">{it.retain_until ? fmt.date(it.retain_until) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
    </Card>
  );
}

function Snapshot({ snapshot }) {
  if (!snapshot) return <div className="card empty">Kein Snapshot gespeichert.</div>;
  return (
    <>
      {snapshot.changes?.length > 0 && (
        <Card title="Änderungen seit dem vorherigen Lauf" flush>
          <table>
            <tbody>
              {snapshot.changes.map((c, i) => (
                <tr key={i}>
                  <td>{c.what ?? c.kind ?? c.component ?? ''}</td>
                  <td className="sub">{c.message ?? `${c.from ?? ''} → ${c.to ?? ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Card title="Komponenten zum Zeitpunkt des Laufs" sub={`Snapshot ${snapshot.hash?.slice(0, 12)} vom ${fmt.date(snapshot.taken_at)}`} flush>
        <table>
          <tbody>
            {snapshot.components.map((c, i) => (
              <tr key={i}>
                <td>{c.name}</td>
                <td className="sub">{c.kind}</td>
                <td>{c.version ?? '–'}</td>
                <td>
                  <span className={`badge ${c.status === 'up' ? 'passed' : 'failed'}`}>{c.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Modelle (Version, Lizenz, Quantisierung)" flush>
        <table>
          <tbody>
            {snapshot.models.map((m, i) => (
              <tr key={i}>
                <td>{m.alias ?? m.name}</td>
                <td className="sub">{m.endpoint}</td>
                <td className="sub">{[m.provider, m.license, m.revision && `rev ${m.revision}`, m.quantization].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
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
