import { useState } from 'react';
import { Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import { api, JsonField, Modal, useApi } from '../../lib.jsx';

const KIND_LABEL = { litellm: 'LiteLLM', vllm: 'vLLM', openai: 'OpenAI-kompatibel', mcp: 'MCP-Server' };

export default function Endpoints() {
  const endpoints = useApi('/api/endpoints');
  const [editing, setEditing] = useState(null);
  const [checks, setChecks] = useState({});

  async function check(e) {
    setChecks((c) => ({ ...c, [e.id]: { pending: true } }));
    const res = await api(`/api/endpoints/${e.id}/check`, { method: 'POST' }).catch((err) => ({ ok: false, error: err.message }));
    setChecks((c) => ({ ...c, [e.id]: res }));
  }

  async function remove(e) {
    if (!confirm(`Endpoint "${e.name}" löschen? Zugehörige Tests werden ebenfalls gelöscht.`)) return;
    await api(`/api/endpoints/${e.id}`, { method: 'DELETE' });
    endpoints.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Endpoints</h1>
          <p>LiteLLM-Gateways, vLLM-Server und MCP-Server, gegen die getestet wird. API-Keys werden verschlüsselt gespeichert.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({})}>
          <Plus size={15} /> Neuer Endpoint
        </button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Typ</th>
              <th>URL</th>
              <th>Modelle</th>
              <th>API-Key</th>
              <th>Verbindung</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(endpoints.data ?? []).map((e) => {
              const c = checks[e.id];
              return (
                <tr key={e.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{e.name}</div>
                    {!e.enabled && <span className="badge warn">deaktiviert</span>}
                    {e.notes && <div className="sub">{e.notes}</div>}
                  </td>
                  <td>
                    <span className="tag">{KIND_LABEL[e.kind]}</span>
                  </td>
                  <td>
                    <code>{e.base_url}</code>
                  </td>
                  <td className="sub">
                    {e.models.join(', ') || '–'}
                    {e.default_model && <div>Standard: {e.default_model}</div>}
                  </td>
                  <td className="sub">{e.api_key_masked ?? '–'}</td>
                  <td className="sub">
                    {c?.pending && 'prüfe…'}
                    {c && !c.pending && (
                      <>
                        <span className={`badge ${c.ok ? 'passed' : 'failed'}`}>{c.ok ? `✓ ${c.latencyMs} ms` : '✕ Fehler'}</span>
                        <div>{c.ok ? (c.models ?? c.tools ?? []).slice(0, 6).join(', ') : c.error?.slice(0, 80)}</div>
                      </>
                    )}
                  </td>
                  <td className="num">
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn sm" onClick={() => check(e)}>
                        <PlugZap size={13} /> Testen
                      </button>
                      <button className="btn sm ghost" onClick={() => setEditing(e)} aria-label="Bearbeiten">
                        <Pencil size={14} />
                      </button>
                      <button className="btn sm ghost danger" onClick={() => remove(e)} aria-label="Löschen">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {endpoints.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Noch keine Endpoints. Lege dein LiteLLM-Gateway oder einen vLLM-Server an.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <EndpointEditor
          endpoint={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            endpoints.reload();
          }}
        />
      )}
    </>
  );
}

function EndpointEditor({ endpoint, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: endpoint.name ?? '',
    kind: endpoint.kind ?? 'litellm',
    base_url: endpoint.base_url ?? '',
    models: (endpoint.models ?? []).join(', '),
    default_model: endpoint.default_model ?? '',
    enabled: endpoint.enabled ?? true,
    notes: endpoint.notes ?? '',
  });
  const [apiKey, setApiKey] = useState(undefined); // undefined = unverändert lassen
  const [headers, setHeaders] = useState(endpoint.headers ?? {});
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    const body = {
      ...form,
      headers,
      models: form.models
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      ...(apiKey !== undefined ? { api_key: apiKey } : {}),
    };
    try {
      await api(endpoint.id ? `/api/endpoints/${endpoint.id}` : '/api/endpoints', { method: endpoint.id ? 'PUT' : 'POST', body });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={endpoint.id ? 'Endpoint bearbeiten' : 'Neuer Endpoint'}
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
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Typ</span>
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Basis-URL</span>
        <input
          type="url"
          value={form.base_url}
          placeholder={form.kind === 'mcp' ? 'https://litellm.example.com/mcp' : 'https://litellm.example.com'}
          onChange={(e) => set({ base_url: e.target.value })}
        />
        <div className="hint">
          {form.kind === 'mcp'
            ? 'Vollständige URL des MCP-Endpunkts (Streamable HTTP).'
            : 'Ohne /v1, z. B. http://vllm.ai.svc.cluster.local:8000 für einen Service im Cluster.'}
        </div>
      </label>
      <label className="field">
        <span>API-Key</span>
        <input
          type="password"
          autoComplete="new-password"
          placeholder={endpoint.has_api_key ? `${endpoint.api_key_masked} (leer lassen = unverändert)` : 'sk-…'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {form.kind !== 'mcp' && (
        <div className="form-grid">
          <label className="field">
            <span>Modelle (kommagetrennt)</span>
            <input value={form.models} placeholder="gpt-oss-120b, llama-3.3-70b" onChange={(e) => set({ models: e.target.value })} />
          </label>
          <label className="field">
            <span>Standardmodell</span>
            <input value={form.default_model} onChange={(e) => set({ default_model: e.target.value })} />
          </label>
        </div>
      )}
      <JsonField label="Zusätzliche Header (JSON)" value={headers} rows={3} onChange={(v, ok) => ok && setHeaders(v)} />
      <label className="field">
        <span>Notiz</span>
        <input value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> aktiv
      </label>
    </Modal>
  );
}
