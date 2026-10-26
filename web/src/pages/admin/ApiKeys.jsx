import { useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, fmt, KEY_VISIBILITY_LABEL, Modal, TeamPicker, useApi, useTeams, useUser, useUserDirectory, VisibilityBadge } from '../../lib.jsx';

// API-Key-Sammlung: Jeder legt Keys für sich und seine Teams an, globale und nur-Admin-Keys nur Administratoren.
export default function ApiKeys() {
  const me = useUser();
  const keys = useApi('/api/api-keys');
  const teams = useTeams();
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';

  async function remove(k) {
    if (!confirm(`API-Key "${k.name}" löschen? Prüfungen und Komponenten, die ihn verwenden, haben danach keinen Key mehr.`)) return;
    try {
      await api(`/api/api-keys/${k.id}`, { method: 'DELETE' });
      keys.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="hint" style={{ flex: 1 }}>
          Keys werden verschlüsselt gespeichert und nie wieder angezeigt. Du siehst deine eigenen Keys, die deiner Teams und globale Keys. Plattform-Komponenten und Prüfungen verweisen nur auf einen Key aus dieser Liste.
        </span>
        <button className="btn primary" onClick={() => setEditing({ visibility: 'user', teamIds: [], userIds: [] })}>
          <Plus size={15} /> Neuer API-Key
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Sichtbar für</th>
              <th>Verwendet von</th>
              <th>Ersteller</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(keys.data ?? []).map((k) => (
              <tr key={k.id}>
                <td>
                  <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                    <span className="icon-chip">
                      <KeyRound size={15} />
                    </span>
                    <span>
                      <div style={{ fontWeight: 600 }}>{k.name}</div>
                      {k.description && <div className="sub">{k.description}</div>}
                    </span>
                  </span>
                </td>
                <td>
                  <code>{k.masked ?? '–'}</code>
                </td>
                <td>
                  <VisibilityBadge visibility={k.visibility} teamNames={k.teamIds.map(teamName)} adminOnly={k.admin_only} />
                  {k.userIds.length > 0 && <div className="sub">+ {k.userIds.length} User direkt zugeordnet</div>}
                </td>
                <td className="sub">
                  {k.endpoints} Endpoints · {k.tests} Tests
                </td>
                <td className="sub">
                  {k.mine ? 'Du' : (k.created_by_name ?? '–')}
                  <div>{fmt.ago(k.created_at)}</div>
                </td>
                <td className="num">
                  {k.can_edit && (
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn sm ghost" onClick={() => setEditing(k)} aria-label="Bearbeiten">
                        <Pencil size={14} />
                      </button>
                      <button className="btn sm ghost danger" onClick={() => remove(k)} aria-label="Löschen">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {keys.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  Noch keine API-Keys sichtbar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <KeyEditor
          me={me}
          apiKey={editing}
          teams={me.is_admin ? (teams.data ?? []) : (me.teams ?? [])}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            keys.reload();
          }}
        />
      )}
    </>
  );
}

function KeyEditor({ me, apiKey, teams, onClose, onSaved }) {
  const users = useUserDirectory();
  const [form, setForm] = useState({
    name: apiKey.name ?? '',
    description: apiKey.description ?? '',
    visibility: apiKey.visibility ?? 'user',
    admin_only: Boolean(apiKey.admin_only),
  });
  const [teamIds, setTeamIds] = useState(apiKey.teamIds ?? []);
  const [userIds, setUserIds] = useState(apiKey.userIds ?? []);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const visibilities = me.is_admin ? ['user', 'teams', 'global'] : ['user', 'teams'];

  async function save() {
    try {
      await api(apiKey.id ? `/api/api-keys/${apiKey.id}` : '/api/api-keys', {
        method: apiKey.id ? 'PUT' : 'POST',
        body: { ...form, teamIds, userIds, ...(secret ? { secret } : {}) },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={apiKey.id ? 'API-Key bearbeiten' : 'Neuer API-Key'}
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
        <input value={form.name} placeholder="z. B. LiteLLM Team Data Science" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="field">
        <span>Beschreibung</span>
        <input value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label className="field">
        <span>Key</span>
        <input
          type="password"
          autoComplete="new-password"
          value={secret}
          placeholder={apiKey.id ? `${apiKey.masked ?? ''} (leer lassen = unverändert)` : 'sk-…'}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Sichtbar für</span>
        <select value={form.visibility} onChange={(e) => set({ visibility: e.target.value })}>
          {visibilities.map((v) => (
            <option key={v} value={v}>
              {KEY_VISIBILITY_LABEL[v]}
              {v === 'teams' ? ' (Mitglieder der gewählten Teams)' : ''}
            </option>
          ))}
        </select>
      </label>
      {form.visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}
      {me.is_admin && (
        <>
          <label className="field" style={{ marginTop: 10 }}>
            <span>Zusätzlich einzelnen Usern zuordnen ({userIds.length})</span>
          </label>
          <div className="pick-list" style={{ maxHeight: 150 }}>
            {(users.data ?? []).map((u) => (
              <label key={u.id}>
                <input
                  type="checkbox"
                  checked={userIds.includes(u.id)}
                  onChange={() => setUserIds(userIds.includes(u.id) ? userIds.filter((x) => x !== u.id) : [...userIds, u.id])}
                />
                <span style={{ fontWeight: 600 }}>{u.name}</span>
              </label>
            ))}
          </div>
          <label className="checkbox" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={form.admin_only} onChange={(e) => set({ admin_only: e.target.checked })} /> Privat: nur andere
            Administratoren sehen und nutzen diesen Key
          </label>
        </>
      )}
    </Modal>
  );
}
