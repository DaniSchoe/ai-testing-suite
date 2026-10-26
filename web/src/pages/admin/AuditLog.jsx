import { useState } from 'react';
import { fmt, Loading, PageHead, qs, useApi } from '../../lib.jsx';

export default function AuditLog() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const log = useApi(`/api/audit-log${qs({ q, action, page })}`);
  const pages = log.data ? Math.max(1, Math.ceil(log.data.total / log.data.pageSize)) : 1;
  return (
    <>
      <PageHead title="Audit-Log">Unveränderliches Protokoll aller sicherheitsrelevanten Aktionen: Anmeldung, Freigaben, Läufe, Änderungen an Katalog, Plattformen, Rollen und Einstellungen.</PageHead>
      <div className="toolbar">
        <input type="search" placeholder="Suchen (Person, Aktion, Objekt)…" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        <select className="inline" value={action} onChange={(e) => (setAction(e.target.value), setPage(1))} aria-label="Bereich">
          <option value="">Alle Bereiche</option>
          {['run', 'approval', 'platform', 'template', 'pack', 'dataset', 'audit', 'finding', 'report', 'member', 'role', 'tenant', 'service_token', 'schedule', 'settings', 'catalog'].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <Loading state={log}>
        {(d) => (
          <>
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Zeitpunkt</th>
                    <th>Person</th>
                    <th>Aktion</th>
                    <th>Mandant</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="sub">{fmt.date(r.ts)}</td>
                      <td>{r.user_name ?? 'System'}</td>
                      <td className="mono">{r.action}</td>
                      <td className="sub">{r.tenant_name ?? '–'}</td>
                      <td className="sub mono" style={{ maxWidth: 480, wordBreak: 'break-word' }}>
                        {r.object_type} {r.object_id?.slice(0, 8)} {r.details && JSON.stringify(r.details).slice(0, 200)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="btn-row" style={{ marginTop: 12, justifyContent: 'center' }}>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Zurück
              </button>
              <span className="sub">
                Seite {page} von {pages} ({d.total} Einträge)
              </span>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Weiter
              </button>
            </div>
          </>
        )}
      </Loading>
    </>
  );
}
