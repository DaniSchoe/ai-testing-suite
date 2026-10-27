import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { api, can, getPlatform, Card, Empty, ErrorBox, Field, fmt, Loading, Modal, PageHead, PATH_LABELS, qs, SEVERITY_LABELS, SeverityBadge, useAction, useApi, useUser, useUserDirectory } from '../lib.jsx';

const STATUS = {
  open: 'Offen',
  in_progress: 'In Bearbeitung',
  fixed: 'Behoben',
  accepted: 'Akzeptiert (Risiko)',
  false_positive: 'Fehlalarm',
};
const RETEST = { passed: 'Nachtest bestanden', still_failing: 'Nachtest: weiterhin Befund' };

export default function Findings() {
  const [filters, setFilters] = useState({ status: '', severity: '', platform_id: getPlatform() ?? '', q: '', open: '1' });
  const list = useApi(`/api/findings${qs(filters)}`, { interval: 30000 });
  const [selected, setSelected] = useState(null);
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <>
      <PageHead title="Findings">
        Sicherheits- und Zugriffsbefunde aus Läufen, dedupliziert nach Vorlage, Modell, Pfad und Fall. Jeder Befund hat eine Schwere, eine Zuordnung zu OWASP LLM Top 10 und einen Verlauf.
      </PageHead>
      <div className="toolbar">
        <input type="search" placeholder="Suchen…" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        <select className="inline" value={filters.severity} onChange={(e) => set({ severity: e.target.value })} aria-label="Schwere">
          <option value="">Alle Schweregrade</option>
          {Object.entries(SEVERITY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="inline" value={filters.status} onChange={(e) => set({ status: e.target.value, open: e.target.value ? '' : '1' })} aria-label="Status">
          <option value="">Offene</option>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Keine Findings. Das ist ein gutes Zeichen, sofern Prüfungen laufen.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Schwere</th>
                    <th>Befund</th>
                    <th>Zuordnung</th>
                    <th>Ziel</th>
                    <th>Status</th>
                    <th>Zuletzt</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id} onClick={() => setSelected(f.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td style={{ minWidth: 260 }}>
                        <div style={{ fontWeight: 600 }}>{f.title}</div>
                        <div className="sub">
                          {f.model ?? '–'} · {PATH_LABELS[f.path] ?? f.path ?? ''} · {f.occurrences}× gesehen
                        </div>
                      </td>
                      <td className="sub">
                        {f.framework} {f.category}
                      </td>
                      <td className="sub">{f.platform_name}</td>
                      <td>
                        {STATUS[f.status]}
                        {f.retest_result && <div className="sub">{RETEST[f.retest_result] ?? f.retest_result}</div>}
                        {f.owner_name && <div className="sub">{f.owner_name}</div>}
                      </td>
                      <td className="sub">{fmt.ago(f.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
      {selected && <FindingDialog id={selected} onClose={() => setSelected(null)} onChanged={list.reload} />}
    </>
  );
}

function FindingDialog({ id, onClose, onChanged }) {
  const user = useUser();
  const navigate = useNavigate();
  const detail = useApi(`/api/findings/${id}`);
  const users = useUserDirectory();
  const [run, error, busy] = useAction();
  const manager = can(user, 'findings.manage');
  const f = detail.data;
  const update = (patch) =>
    run(async () => {
      await api(`/api/findings/${id}`, { method: 'PUT', body: patch });
      detail.reload();
      onChanged();
    });
  const retest = () =>
    run(async () => {
      const r = await api(`/api/findings/${id}/retest`, { method: 'POST' });
      navigate(`/runs/${r.id}`);
    });
  return (
    <Modal
      title={f?.title ?? 'Finding'}
      onClose={onClose}
      footer={
        manager && f ? (
          <>
            <button className="btn" onClick={retest} disabled={busy || !can(user, 'runs.start') || !f.audit_id}>
              <Play size={14} /> Nachtest
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onClose}>
              Schließen
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose}>
            Schließen
          </button>
        )
      }
    >
      <ErrorBox error={error} />
      {!f && <div className="empty">Lädt…</div>}
      {f && (
        <>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <SeverityBadge severity={f.severity} />
            <span className="tag">
              {f.framework} {f.category}
            </span>
            <span className="sub">
              seit {fmt.date(f.first_seen_at)} · {f.occurrences}× gesehen
            </span>
          </div>
          <p>{f.description}</p>
          {f.last_run_id && (
            <p className="sub">
              Letzter Lauf: <Link to={`/runs/${f.last_run_id}`}>ansehen</Link>
            </p>
          )}
          {f.evidence?.prompt === null && f.evidence?.masked && <div className="hint">Angriffsinhalte sind ohne die Berechtigung security.payloads maskiert.</div>}
          {f.evidence?.prompt && (
            <details>
              <summary className="sub">Nachweis</summary>
              <pre className="json">{JSON.stringify(f.evidence, null, 2)}</pre>
            </details>
          )}
          {manager && (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="Status">
                <select value={f.status} onChange={(e) => update({ status: e.target.value })}>
                  {Object.entries(STATUS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Schwere">
                <select value={f.severity} onChange={(e) => update({ severity: e.target.value })}>
                  {Object.entries(SEVERITY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Verantwortlich">
                <select value={f.owner_id ?? ''} onChange={(e) => update({ owner_id: e.target.value })}>
                  <option value="">– niemand –</option>
                  {(users.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {manager && <NoteField key={f.note} value={f.note} onSave={(note) => update({ note })} />}
          <Card title="Verlauf" flush>
            <table>
              <tbody>
                {f.events.map((e) => (
                  <tr key={e.id}>
                    <td className="sub">{fmt.date(e.ts)}</td>
                    <td>{e.user_name ?? 'System'}</td>
                    <td className="sub">
                      {e.kind}
                      {e.data && ` ${JSON.stringify(e.data).slice(0, 140)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </Modal>
  );
}

function NoteField({ value, onSave }) {
  const [text, setText] = useState(value ?? '');
  return (
    <Field label="Notiz">
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== (value ?? '') && onSave(text)} />
    </Field>
  );
}
