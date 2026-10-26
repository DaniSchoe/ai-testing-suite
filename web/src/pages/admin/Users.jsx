import { useState } from 'react';
import { Pencil, Trash2, UserPlus } from 'lucide-react';
import { api, can, fmt, initials, Modal, useApi, useUser } from '../../lib.jsx';

// Darf der angemeldete User diese Rolle vergeben oder entziehen? (gleiche Regel wie im Server)
function canGrant(me, role) {
  if (me.is_admin) return true;
  return role.key !== 'admin' && role.permissions.every((p) => me.permissions.includes(p));
}

function UserStatus({ u }) {
  if (u.disabled) return <span className="badge failed">Gesperrt</span>;
  if (u.pending) return <span className="badge queued">Wartet auf ersten Login</span>;
  return <span className="badge passed">Aktiv</span>;
}

export default function Users() {
  const me = useUser();
  const users = useApi('/api/members');
  const roles = useApi(can(me, 'users.manage') ? '/api/roles' : null);
  const teams = useApi('/api/teams');
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('');

  const list = (users.data ?? []).filter((u) =>
    `${u.display_name ?? ''} ${u.username ?? ''} ${u.email ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
  );

  async function remove(u) {
    if (!confirm(`${u.email} aus diesem Mandanten entfernen? Das Konto selbst bleibt bestehen.`)) return;
    await api(`/api/members/${u.id}`, { method: 'DELETE' });
    users.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mitglieder</h1>
          <p>
            Die Anmeldung läuft über Keycloak, Rollen und Teams vergibst du hier. Neue User erhalten beim ersten Login die Standardrolle. User lassen
            sich auch vorab per E-Mail anlegen; Rollen und Teams gelten dann ab dem ersten Login mit dieser (in Keycloak bestätigten) Adresse.
          </p>
        </div>
        {can(me, 'users.manage') && (
          <button className="btn primary" onClick={() => setEditing({ pending: true, roles: [], teams: [] })}>
            <UserPlus size={15} /> User vorab anlegen
          </button>
        )}
      </div>
      <div className="card">
        <div className="toolbar">
          <input type="search" placeholder="Name oder E-Mail filtern…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="sub" style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
            {list.length} von {users.data?.length ?? 0} Usern
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Benutzer</th>
                <th>Rollen</th>
                <th>Teams</th>
                <th>Status</th>
                <th className="num">Läufe</th>
                <th className="num">Letzter Login</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                      <span className="avatar sm">{initials(u.display_name ?? u.username ?? u.email)}</span>
                      <span>
                        <div style={{ fontWeight: 600 }}>{u.display_name ?? u.username ?? u.email}</div>
                        <div className="sub">{u.email ?? u.username}</div>
                      </span>
                    </span>
                  </td>
                  <td>
                    <div className="tags">
                      {u.env_admin && (
                        <span className="badge running" title="Über die Umgebungsvariable ADMIN_EMAILS">
                          Admin per E-Mail
                        </span>
                      )}
                      {u.roles.map((r) => (
                        <span key={r.id} className="tag">
                          {r.name}
                        </span>
                      ))}
                      {!u.env_admin && u.roles.length === 0 && <span className="sub">keine Rolle</span>}
                    </div>
                  </td>
                  <td>
                    <div className="tags">
                      {u.teams.map((t) => (
                        <span key={t.id} className="tag">
                          {t.name}
                        </span>
                      ))}
                      {u.teams.length === 0 && <span className="sub">–</span>}
                    </div>
                  </td>
                  <td>
                    <UserStatus u={u} />
                  </td>
                  <td className="num">{u.runs}</td>
                  <td className="num sub">{fmt.ago(u.last_login_at)}</td>
                  <td className="num">
                    {can(me, 'users.manage') && (
                      <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <button className="btn sm ghost" onClick={() => setEditing(u)} aria-label="Bearbeiten">
                          <Pencil size={14} />
                        </button>
                        {u.pending && (
                          <button className="btn sm ghost danger" onClick={() => remove(u)} aria-label="Löschen">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {users.data && list.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    Keine User gefunden
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {editing && (
        <UserEditor
          user={editing}
          me={me}
          roles={roles.data ?? []}
          teams={teams.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            users.reload();
          }}
        />
      )}
    </>
  );
}

function UserEditor({ user, me, roles, teams, onClose, onSaved }) {
  const isNew = !user.id;
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [roleIds, setRoleIds] = useState(() => new Set(isNew ? roles.filter((r) => r.is_default).map((r) => r.id) : user.roles.map((r) => r.id)));
  const [teamIds, setTeamIds] = useState(() => new Set(user.teams.map((t) => t.id)));
  const [disabled, setDisabled] = useState(Boolean(user.disabled));
  const [error, setError] = useState(null);

  const toggle = (set, setter, id) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    setter(next);
  };

  async function save() {
    try {
      const body = { display_name: displayName, roleIds: [...roleIds], teamIds: [...teamIds] };
      if (isNew) await api('/api/members', { method: 'POST', body: { ...body, email } });
      else {
        await api(`/api/members/${user.id}`, { method: 'PUT', body });
        if (disabled !== Boolean(user.disabled)) await api(`/api/users/${user.id}`, { method: 'PUT', body: { ...body, disabled } });
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={isNew ? 'User vorab anlegen' : `${user.display_name ?? user.username} bearbeiten`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      <div className="form-grid">
        {isNew ? (
          <label className="field">
            <span>E-Mail (wie in Keycloak)</span>
            <input type="email" value={email} placeholder="vorname.nachname@firma.de" onChange={(e) => setEmail(e.target.value)} />
          </label>
        ) : (
          <label className="field">
            <span>E-Mail</span>
            <input value={user.email ?? ''} disabled />
          </label>
        )}
        <label className="field">
          <span>Anzeigename</span>
          <input value={displayName} placeholder={isNew ? 'wird beim Login aus Keycloak übernommen' : ''} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      </div>
      {user.env_admin && <div className="hint" style={{ marginBottom: 12 }}>Dieser User ist über ADMIN_EMAILS immer Administrator, unabhängig von den Rollen hier.</div>}

      <label className="field" style={{ marginBottom: 6 }}>
        <span>Rollen</span>
      </label>
      <div className="pick-list">
        {roles.map((r) => {
          const allowed = canGrant(me, r);
          return (
            <label key={r.id} className={allowed ? '' : 'disabled'} title={allowed ? '' : 'Du kannst nur Rollen vergeben, deren Berechtigungen du selbst hast'}>
              <input type="checkbox" checked={roleIds.has(r.id)} disabled={!allowed} onChange={() => toggle(roleIds, setRoleIds, r.id)} />
              <span>
                <div style={{ fontWeight: 600 }}>
                  {r.name} {r.is_default && <span className="badge">Standard</span>}
                </div>
                <div className="sub">{r.description || `${r.permissions.length} Berechtigungen`}</div>
              </span>
            </label>
          );
        })}
      </div>

      <label className="field" style={{ marginBottom: 6 }}>
        <span>Teams</span>
      </label>
      <div className="pick-list">
        {teams.map((t) => (
          <label key={t.id}>
            <input type="checkbox" checked={teamIds.has(t.id)} onChange={() => toggle(teamIds, setTeamIds, t.id)} />
            <span>
              <div style={{ fontWeight: 600 }}>{t.name}</div>
              <div className="sub">{t.description || `${t.members.length} Mitglieder`}</div>
            </span>
          </label>
        ))}
        {teams.length === 0 && <div className="empty">Noch keine Teams angelegt</div>}
      </div>

      {!isNew && user.id !== me.id && can(me, 'roles.manage') && (
        <label className="checkbox">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /> Gesperrt (kein Zugriff, Historie bleibt erhalten)
        </label>
      )}
    </Modal>
  );
}
