import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Download, RefreshCw, Send, Sparkles } from 'lucide-react';
import { api, can, Card, download, Empty, ErrorBox, fmt, LifecycleBadge, Loading, OutcomeBadge, PageHead, pctText, useAction, useApi, useUser } from '../lib.jsx';

export function Reports() {
  const user = useUser();
  const [status, setStatus] = useState('');
  const list = useApi(`/api/reports${status ? `?status=${status}` : ''}`);
  return (
    <>
      <PageHead title="Berichte">
        Zu jedem Lauf entsteht ein Prüfbericht aus den gemessenen Daten. Die Zusammenfassung ist redigierbar; ein Reviewer gibt den Bericht nach dem Vier-Augen-Prinzip frei. Kunden-Viewer sehen nur freigegebene Berichte.
      </PageHead>
      {can(user, 'tests.manage') && (
        <div className="toolbar">
          <select className="inline" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Alle Stände</option>
            <option value="draft">Entwurf</option>
            <option value="in_review">In Prüfung</option>
            <option value="approved">Freigegeben</option>
          </select>
        </div>
      )}
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Keine Berichte.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bericht</th>
                    <th>Ziel</th>
                    <th>Gesamturteil</th>
                    <th>Stand</th>
                    <th>Lauf</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link className="title-link" to={`/reports/${r.id}`}>
                          {r.audit_name ?? 'Bericht'}
                        </Link>
                      </td>
                      <td>{r.platform?.name}</td>
                      <td>{r.rating?.label}</td>
                      <td>
                        <LifecycleBadge status={r.status} />
                      </td>
                      <td className="sub">{fmt.date(r.finished_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
    </>
  );
}

export function ReportDetail() {
  const { id } = useParams();
  const user = useUser();
  const report = useApi(`/api/reports/${id}`);
  const [summary, setSummary] = useState(null);
  const [run, error, busy] = useAction();
  const editor = can(user, 'tests.manage');
  const reviewer = can(user, 'reports.approve');
  const post = (action, body) =>
    run(async () => {
      await api(`/api/reports/${id}/${action}`, { method: 'POST', body });
      setSummary(null);
      report.reload();
    });
  const save = () =>
    run(async () => {
      await api(`/api/reports/${id}`, { method: 'PUT', body: { summary } });
      setSummary(null);
      report.reload();
    });
  const exportAs = (format) =>
    run(async () => {
      download(`pruefbericht-${id.slice(0, 8)}.${format}`, await api(`/api/reports/${id}/export?format=${format}`, { raw: true }), format === 'md' ? 'text/markdown' : 'text/html');
    });

  return (
    <Loading state={report}>
      {(r) => {
        const b = r.body;
        const text = summary ?? r.summary ?? '';
        const locked = r.status === 'approved';
        return (
          <>
            <PageHead
              title={
                <>
                  Prüfbericht {r.audit_name} <LifecycleBadge status={r.status} />
                </>
              }
              action={
                <div className="btn-row">
                  <button className="btn" onClick={() => exportAs('md')}>
                    <Download size={14} /> Markdown
                  </button>
                  <button className="btn" onClick={() => exportAs('html')}>
                    <Download size={14} /> HTML
                  </button>
                  {r.status === 'draft' && editor && (
                    <>
                      <button className="btn" onClick={() => post('refresh')} disabled={busy}>
                        <RefreshCw size={14} /> Neu berechnen
                      </button>
                      <button className="btn primary" onClick={() => post('submit')} disabled={busy}>
                        <Send size={14} /> Zur Freigabe
                      </button>
                    </>
                  )}
                  {r.status === 'in_review' && reviewer && (
                    <>
                      <button className="btn primary" onClick={() => post('approve', { note: prompt('Anmerkung (optional)') ?? undefined })} disabled={busy}>
                        <Check size={14} /> Freigeben
                      </button>
                      <button
                        className="btn danger"
                        onClick={() => {
                          const note = prompt('Begründung der Ablehnung');
                          if (note) post('reject', { note });
                        }}
                      >
                        Zurückweisen
                      </button>
                    </>
                  )}
                </div>
              }
            >
              {b.platform.name} · <Link to={`/runs/${r.run_id}`}>Lauf vom {fmt.date(b.run.finished_at)}</Link> · Gesamturteil: <strong>{b.rating.label}</strong>
              {r.approved_by_name && ` · freigegeben von ${r.approved_by_name} am ${fmt.date(r.approved_at)}`}
            </PageHead>
            <ErrorBox error={error} />
            {r.approval_note && <div className="hint">Anmerkung der Prüfung: {r.approval_note}</div>}
            <Card
              title="Zusammenfassung"
              sub="Der Standardtext entsteht aus den Daten. Änderungen sind nur im Entwurf möglich."
              action={
                summary !== null &&
                !locked && (
                  <button className="btn sm primary" onClick={save} disabled={busy}>
                    Speichern
                  </button>
                )
              }
            >
              <textarea rows={6} disabled={locked || !editor} value={text} onChange={(e) => setSummary(e.target.value)} />
            </Card>
            {r.ai_draft && !locked && (
              <Card
                title={
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <Sparkles size={16} /> KI-Entwurf
                  </span>
                }
                sub="Wird nie automatisch übernommen. Ein Reviewer übernimmt ihn ausdrücklich in die Zusammenfassung."
                action={
                  reviewer && (
                    <button className="btn sm" onClick={() => post('adopt-ai')} disabled={busy}>
                      In Zusammenfassung übernehmen
                    </button>
                  )
                }
              >
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{r.ai_draft}</pre>
              </Card>
            )}
            <div className="btn-row" style={{ margin: '12px 0' }}>
              {Object.entries(b.outcomes).map(([k, n]) => (
                <span key={k} className="btn-row" style={{ gap: 4 }}>
                  <strong>{n}</strong> <OutcomeBadge outcome={k} />
                </span>
              ))}
              {b.regressions > 0 && <span className="badge warn">{b.regressions} Regression(en)</span>}
            </div>
            {b.findings.length > 0 && (
              <Card title="Findings" flush>
                <table>
                  <tbody>
                    {b.findings.map((f, i) => (
                      <tr key={i}>
                        <td>{f.severity}</td>
                        <td>{f.title}</td>
                        <td className="sub">{f.model}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
            <Card title="Ergebnisse" flush>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Vorlage</th>
                      <th>Modell · Pfad</th>
                      <th>Ergebnis</th>
                      <th className="num">Score</th>
                      <th>Hinweis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.ratings.map((x, i) => (
                      <tr key={i}>
                        <td>
                          {x.name} <span className="mono sub">{x.version}</span>
                        </td>
                        <td className="sub">
                          {x.model ?? '–'} · {x.path ?? ''}
                        </td>
                        <td>
                          <OutcomeBadge outcome={x.outcome} />
                        </td>
                        <td className="num">{x.score === null ? '–' : pctText(x.score)}</td>
                        <td className="sub">
                          {x.violations?.map((v) => v.message).join(' · ')}
                          {x.small_sample && ' kleine Stichprobe'}
                          {x.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Zuordnung zu Rahmenwerken" flush>
              <table>
                <tbody>
                  {b.framework_mapping.map((f, i) => (
                    <tr key={i}>
                      <td>{f.framework}</td>
                      <td>
                        {f.key} {f.name}
                      </td>
                      <td>
                        {f.passed} bestanden{f.failed ? `, ${f.failed} nicht bestanden` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="hint">
              Nachweiskette (SHA-256): <span className="mono">{b.evidence_hash ?? 'nicht versiegelt'}</span> · Snapshot <span className="mono">{b.snapshot?.hash?.slice(0, 16)}</span>
            </div>
          </>
        );
      }}
    </Loading>
  );
}
