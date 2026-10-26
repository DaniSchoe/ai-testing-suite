import { fmt, initials, useApi } from '../../lib.jsx';

const ROLE_LABEL = { admin: 'Administrator', tester: 'Tester', viewer: 'Betrachter' };

export default function Users() {
  const users = useApi('/api/users');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Benutzer</h1>
          <p>Benutzer und Rollen kommen aus Keycloak (Rollen suite-admin, suite-tester, suite-viewer) und werden bei jedem Login aktualisiert.</p>
        </div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Benutzer</th>
              <th>E-Mail</th>
              <th>Rollen</th>
              <th className="num">Läufe</th>
              <th className="num">Letzter Lauf</th>
              <th className="num">Letzter Login</th>
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>
                  <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                    <span className="avatar sm">{initials(u.display_name ?? u.username)}</span>
                    <span>
                      <div style={{ fontWeight: 600 }}>{u.display_name ?? u.username}</div>
                      <div className="sub">{u.username}</div>
                    </span>
                  </span>
                </td>
                <td>{u.email ?? '–'}</td>
                <td>
                  {u.roles.map((r) => (
                    <span key={r} className="tag" style={{ marginRight: 4 }}>
                      {ROLE_LABEL[r] ?? r}
                    </span>
                  ))}
                </td>
                <td className="num">{u.runs}</td>
                <td className="num sub">{fmt.ago(u.last_run_at)}</td>
                <td className="num sub">{fmt.ago(u.last_login_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
