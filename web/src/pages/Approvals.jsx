import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { api, can, getPlatform, qs, Card, Empty, EnvBadge, ErrorBox, Field, fmt, LifecycleBadge, Loading, Modal, PageHead, Tabs, useAction, useApi, useUser } from '../lib.jsx';

export function ApprovalsPanel() {
  const user = useUser();
  const [tab, setTab] = useState('pending');
  const list = useApi(`/api/approvals${qs({ status: tab === 'pending' ? 'pending' : '', platform_id: getPlatform() })}`, { interval: 15000 });
  const [deciding, setDeciding] = useState(null);
  const [run, error] = useAction();
  const approver = can(user, 'runs.prod');
  const revoke = (ap) =>
    confirm('Freigabe widerrufen?') &&
    run(async () => {
      await api(`/api/approvals/${ap.id}/revoke`, { method: 'POST' });
      list.reload();
    });
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Läufe gegen Prod-Plattformen und Lasttests brauchen eine Freigabe nach dem Vier-Augen-Prinzip: Wer beantragt, entscheidet nicht. Eine Freigabe gilt für eine Prüfung, ein Zeitfenster, eine Anzahl Läufe und Lastgrenzen. Anträge sehen nur die zugewiesene Person bzw. die Prüfer des zugewiesenen Teams.
      </p>
      <ErrorBox error={error} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['pending', 'Offene Anträge'],
          ['all', 'Alle'],
        ]}
      />
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>{tab === 'pending' ? 'Keine offenen Anträge.' : 'Noch keine Freigaben.'}</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Prüfung</th>
                    <th>Ziel</th>
                    <th>Beantragt</th>
                    <th>Zugewiesen an</th>
                    <th>Stand</th>
                    <th>Umfang</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ap) => (
                    <tr key={ap.id}>
                      <td>
                        <Link to={`/audits/${ap.audit_id}`}>{ap.audit_name}</Link>
                        {ap.request_note && <div className="sub">{ap.request_note}</div>}
                      </td>
                      <td>
                        {ap.platform_name} <EnvBadge env={ap.environment} />
                      </td>
                      <td className="sub">
                        {ap.requested_by_name}
                        <div>{fmt.date(ap.requested_at)}</div>
                      </td>
                      <td className="sub">{ap.assigned_user_name ?? ap.assigned_team_name ?? 'Alle Prüfer'}</td>
                      <td>
                        <LifecycleBadge status={ap.status} />
                        {ap.decided_by_name && <div className="sub">{ap.decided_by_name}</div>}
                        {ap.decision_note && <div className="sub">„{ap.decision_note}“</div>}
                      </td>
                      <td className="sub">
                        {ap.runs_used}/{ap.runs_allowed} Läufe
                        {(ap.window_from || ap.window_to) && <div>{`${fmt.date(ap.window_from)} – ${fmt.date(ap.window_to)}`}</div>}
                        {ap.limits?.max_concurrency && <div>max. {ap.limits.max_concurrency} parallel</div>}
                        {ap.limits?.max_duration_s && <div>max. {ap.limits.max_duration_s} s</div>}
                      </td>
                      <td className="num">
                        {approver && ap.status === 'pending' && (
                          <button className="btn sm primary" onClick={() => setDeciding(ap)} disabled={!ap.can_decide} title={ap.requested_by === user.id ? 'Vier-Augen-Prinzip: Eigene Anträge entscheidet eine andere Person' : ''}>
                            Entscheiden
                          </button>
                        )}
                        {approver && ap.status === 'approved' && (
                          <button className="btn sm" onClick={() => revoke(ap)}>
                            Widerrufen
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
      {deciding && <DecideDialog approval={deciding} onClose={() => setDeciding(null)} onDone={() => (setDeciding(null), list.reload())} />}
    </>
  );
}

function DecideDialog({ approval, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [runs, setRuns] = useState(approval.runs_allowed);
  const [conc, setConc] = useState(approval.limits?.max_concurrency ?? '');
  const [dur, setDur] = useState(approval.limits?.max_duration_s ?? '');
  const [run, error, busy] = useAction();
  const decide = (decision) =>
    run(async () => {
      await api(`/api/approvals/${approval.id}/decision`, {
        method: 'POST',
        body: {
          decision,
          note,
          runs_allowed: runs,
          window_from: from ? new Date(from).toISOString() : null,
          window_to: to ? new Date(to).toISOString() : null,
          limits: { max_concurrency: conc || undefined, max_duration_s: dur || undefined },
        },
      });
      onDone();
    });
  return (
    <Modal
      title={`${approval.audit_name}: Antrag entscheiden`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>
            <X size={14} /> Ablehnen
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy} onClick={() => decide('approve')}>
            <Check size={14} /> Freigeben
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Anmerkung">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label="Gültig ab">
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Gültig bis">
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Erlaubte Läufe">
          <input type="number" min={1} value={runs} onChange={(e) => setRuns(Number(e.target.value))} />
        </Field>
        <Field label="Max. Parallelität">
          <input type="number" min={1} value={conc} onChange={(e) => setConc(e.target.value)} />
        </Field>
        <Field label="Max. Dauer (s)">
          <input type="number" min={1} value={dur} onChange={(e) => setDur(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
