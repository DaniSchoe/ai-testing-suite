import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, JsonField, Modal, useApi } from '../../lib.jsx';

const AUTH_LABEL = {
  api_key: 'LiteLLM-Key / Virtual Key',
  keycloak_password: 'Keycloak-User (JWT)',
  none: 'Ohne Credentials',
};

export default function Personas() {
  const personas = useApi('/api/personas');
  const [editing, setEditing] = useState(null);

  async function remove(p) {
    if (!confirm(`Persona "${p.name}" löschen?`)) return;
    await api(`/api/personas/${p.id}`, { method: 'DELETE' });
    personas.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Test-Personas</h1>
          <p>
            Test-User, unter deren Identität Tests laufen. So lassen sich userspezifische Freigaben für Modelle und MCP-Tools prüfen. Standard ist ein
            LiteLLM-Key pro User oder Team; alternativ holt sich ein Keycloak-User sein Token über den Persona-Client.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEditing({})}>
          <Plus size={15} /> Neue Persona
        </button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Anmeldung</th>
              <th>Benutzername</th>
              <th>Attribute</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(personas.data ?? []).map((p) => (
              <tr key={p.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="sub">{p.description}</div>
                </td>
                <td>
                  <span className="tag">{AUTH_LABEL[p.auth_type]}</span>
                  {p.auth_type !== 'none' && !p.has_secret && <span className="badge warn">kein Secret</span>}
                </td>
                <td>{p.username ?? '–'}</td>
                <td className="sub">
                  <code>{Object.keys(p.attributes ?? {}).length ? JSON.stringify(p.attributes) : '–'}</code>
                </td>
                <td className="num">
                  <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => setEditing(p)} aria-label="Bearbeiten">
                      <Pencil size={14} />
                    </button>
                    <button className="btn sm ghost danger" onClick={() => remove(p)} aria-label="Löschen">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {personas.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Noch keine Personas
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <PersonaEditor
          persona={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            personas.reload();
          }}
        />
      )}
    </>
  );
}

function PersonaEditor({ persona, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: persona.name ?? '',
    description: persona.description ?? '',
    auth_type: persona.auth_type ?? 'api_key',
    username: persona.username ?? '',
  });
  const [secret, setSecret] = useState(undefined);
  const [attributes, setAttributes] = useState(persona.attributes ?? {});
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    try {
      await api(persona.id ? `/api/personas/${persona.id}` : '/api/personas', {
        method: persona.id ? 'PUT' : 'POST',
        body: { ...form, attributes, ...(secret !== undefined ? { secret } : {}) },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={persona.id ? 'Persona bearbeiten' : 'Neue Persona'}
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
        <label className="field">
          <span>Name</span>
          <input value={form.name} placeholder="team-a-analyst" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Anmeldung</span>
          <select value={form.auth_type} onChange={(e) => set({ auth_type: e.target.value })}>
            {Object.entries(AUTH_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Beschreibung</span>
        <input value={form.description} placeholder="Welche Freigaben soll diese Persona haben?" onChange={(e) => set({ description: e.target.value })} />
      </label>
      {form.auth_type === 'keycloak_password' && (
        <label className="field">
          <span>Keycloak-Benutzername</span>
          <input value={form.username} onChange={(e) => set({ username: e.target.value })} />
        </label>
      )}
      {form.auth_type !== 'none' && (
        <label className="field">
          <span>{form.auth_type === 'api_key' ? 'API-Key' : 'Passwort'}</span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={persona.has_secret ? 'leer lassen = unverändert' : ''}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}
      <JsonField
        label="Attribute (JSON)"
        value={attributes}
        rows={4}
        hint='Frei wählbar, z. B. {"team": "A", "groups": ["analysts"]}. Dient der Dokumentation erwarteter Rechte.'
        onChange={(v, ok) => ok && setAttributes(v)}
      />
    </Modal>
  );
}
