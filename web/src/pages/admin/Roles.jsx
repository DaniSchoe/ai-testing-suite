import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Modal, useApi, useUser } from '../../lib.jsx';

// Berechtigungsmatrix: Zeilen = Berechtigungen, Spalten = Rollen. Ein Klick speichert sofort.
export default function Roles() {
  const me = useUser();
  const permissions = useApi('/api/permissions');
  const roles = useApi('/api/roles');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  async function save(role, patch) {
    setError(null);
    try {
      await api(`/api/roles/${role.id}`, { method: 'PUT', body: { ...role, ...patch } });
      roles.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  function togglePermission(role, key) {
    const next = role.permissions.includes(key) ? role.permissions.filter((p) => p !== key) : [...role.permissions, key];
    save(role, { permissions: next });
  }

  async function remove(role) {
    if (!confirm(`Rolle "${role.name}" löschen? ${role.users} User verlieren diese Rolle.`)) return;
    try {
      await api(`/api/roles/${role.id}`, { method: 'DELETE' });
      roles.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  const list = roles.data ?? [];
  // Nur Berechtigungen, die man selbst hat, lassen sich vergeben (Admins haben alle).
  const grantable = (key) => me.is_admin || me.permissions.includes(key);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rollen & Berechtigungen</h1>
          <p>
            Lege fest, welche Rolle was darf. Ein User hat die Summe der Berechtigungen all seiner Rollen. Die Rolle Administrator hat immer alle
            Berechtigungen, ebenso alle E-Mail-Adressen aus ADMIN_EMAILS.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ permissions: ['suite.view'] })}>
          <Plus size={15} /> Neue Rolle
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="card table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Berechtigung</th>
              {list.map((r) => (
                <th key={r.id} className="check">
                  <div>{r.name}</div>
                  <div style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginTop: 2 }}>
                    {r.users} User{r.is_default ? ' · Standard' : ''}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(permissions.data ?? []).map((p) => (
              <tr key={p.key}>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.label}</div>
                  <div className="sub">
                    {p.description} · <code>{p.key}</code>
                  </div>
                </td>
                {list.map((r) => (
                  <td key={r.id} className="check">
                    <input
                      type="checkbox"
                      aria-label={`${p.label} für ${r.name}`}
                      checked={r.permissions.includes(p.key)}
                      disabled={r.key === 'admin' || !grantable(p.key)}
                      onChange={() => togglePermission(r, p.key)}
                    />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td />
              {list.map((r) => (
                <td key={r.id} className="check">
                  <span className="btn-row" style={{ justifyContent: 'center', flexWrap: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => setEditing(r)} aria-label={`${r.name} bearbeiten`}>
                      <Pencil size={14} />
                    </button>
                    {r.key !== 'admin' && (
                      <button className="btn sm ghost danger" onClick={() => remove(r)} aria-label={`${r.name} löschen`}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {editing && (
        <RoleEditor
          role={editing}
          permissions={permissions.data ?? []}
          grantable={grantable}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            roles.reload();
          }}
        />
      )}
    </>
  );
}

function RoleEditor({ role, permissions, grantable, onClose, onSaved }) {
  const isAdminRole = role.key === 'admin';
  const [form, setForm] = useState({ name: role.name ?? '', description: role.description ?? '', is_default: Boolean(role.is_default) });
  const [perms, setPerms] = useState(() => new Set(role.permissions ?? []));
  const [error, setError] = useState(null);

  async function save() {
    try {
      await api(role.id ? `/api/roles/${role.id}` : '/api/roles', {
        method: role.id ? 'PUT' : 'POST',
        body: { ...form, permissions: [...perms] },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={role.id ? `Rolle ${role.name} bearbeiten` : 'Neue Rolle'}
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
      <label className="field">
        <span>Name</span>
        <input value={form.name} placeholder="z. B. Teamleitung" onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="field">
        <span>Beschreibung</span>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      {!isAdminRole && (
        <>
          <label className="checkbox" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} /> Standardrolle für
            neue User
          </label>
          <label className="field" style={{ marginBottom: 6 }}>
            <span>Berechtigungen</span>
          </label>
          <div className="pick-list" style={{ maxHeight: 340 }}>
            {permissions.map((p) => (
              <label key={p.key} className={grantable(p.key) ? '' : 'disabled'}>
                <input
                  type="checkbox"
                  checked={perms.has(p.key)}
                  disabled={!grantable(p.key)}
                  onChange={() => {
                    const next = new Set(perms);
                    next.has(p.key) ? next.delete(p.key) : next.add(p.key);
                    setPerms(next);
                  }}
                />
                <span>
                  <div style={{ fontWeight: 600 }}>{p.label}</div>
                  <div className="sub">{p.description}</div>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      {isAdminRole && <div className="hint">Die Rolle Administrator hat immer alle Berechtigungen.</div>}
    </Modal>
  );
}
