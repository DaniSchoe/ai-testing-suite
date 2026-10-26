import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import {
  api,
  EnvBadge,
  fmt,
  JsonField,
  KIND_META,
  KindBadge,
  Modal,
  PUBLISH_LABEL,
  TeamPicker,
  useApi,
  useTeams,
  useUserDirectory,
  VisibilityBadge,
} from '../../lib.jsx';

const FLAVORS = [
  ['openai', 'OpenAI-compatible'],
  ['claude', 'Claude (Anthropic Messages API)'],
];

export default function Components({ platform }) {
  const endpoints = useApi(`/api/endpoints?platform_id=${platform.id}`);
  const teams = useTeams();
  const [editing, setEditing] = useState(null);
  const [checks, setChecks] = useState({});
  const [discovered, setDiscovered] = useState(null);
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';

  async function check(e) {
    setChecks((c) => ({ ...c, [e.id]: { pending: true } }));
    const res = await api(`/api/endpoints/${e.id}/check`, { method: 'POST' }).catch((err) => ({ ok: false, error: err.message }));
    setChecks((c) => ({ ...c, [e.id]: res }));
    endpoints.reload();
  }

  async function remove(e) {
    if (!confirm(`Endpoint "${e.name}" löschen? Prüfungen mit diesem Endpoint verlieren ihr Ziel.`)) return;
    await api(`/api/endpoints/${e.id}`, { method: 'DELETE' });
    endpoints.reload();
  }

  return (
    <>
      <div className="toolbar">
        <span className="hint" style={{ flex: 1 }}>
          AI Proxys (z. B. LiteLLM), LLM-Endpoints (OpenAI-compatible oder Claude, z. B. ein vLLM-Server pro Modell) und MCP-Server dieser Plattform. Den API-Key wählst du unter{' '}
          <Link to="/credentials">Zugangsdaten</Link>.
        </span>
        <button className="btn primary" onClick={() => setEditing({})}>
          <Plus size={15} /> Neue Komponente
        </button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Art</th>
              <th>Modelle</th>
              <th>Veröffentlicht</th>
              <th>Verbindung</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(endpoints.data ?? []).map((e) => {
              const c = checks[e.id];
              const meta = KIND_META[e.kind];
              return (
                <tr key={e.id}>
                  <td style={{ minWidth: 260 }}>
                    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                      <span className="icon-chip" style={{ color: meta?.color }}>
                        {meta && <meta.Icon size={16} />}
                      </span>
                      <span>
                        <div style={{ fontWeight: 600 }}>
                          {e.name} <EnvBadge env={e.environment} />
                        </div>
                        {!e.enabled && <span className="badge warn">deaktiviert</span>}
                        <div className="sub">
                          {e.maintainer_name ? `Maintainer: ${e.maintainer_name}` : 'Kein Maintainer'}
                          {e.api_key_name ? ` · Key: ${e.api_key_name}` : ''}
                        </div>
                        {e.notes && <div className="sub">{e.notes}</div>}
                      </span>
                    </span>
                  </td>
                  <td>
                    <KindBadge kind={e.kind} flavor={e.llm_flavor} />
                  </td>
                  <td className="sub">
                    {e.kind === 'mcp' ? (
                      '–'
                    ) : (
                      <>
                        <Link to="/models">{e.models.filter((m) => m.available).length} Modelle</Link>
                        {e.models.some((m) => !m.available) && <span> · {e.models.filter((m) => !m.available).length} verschwunden</span>}
                        {e.default_model && <div>Standard: {e.default_model}</div>}
                        <div>{e.auto_discover ? `abgefragt ${fmt.ago(e.models_synced_at)}` : 'manuell gepflegt'}</div>
                        {e.models_sync_error && <div style={{ color: 'var(--bad)' }}>Abruf fehlgeschlagen</div>}
                      </>
                    )}
                  </td>
                  <td>
                    <VisibilityBadge visibility={e.visibility} teamNames={e.teamIds.map(teamName)} />
                  </td>
                  <td className="sub">
                    {c?.pending && 'prüfe…'}
                    {c && !c.pending && <TestResult result={c} />}
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
                <td colSpan={6} className="empty">
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
          platform={platform}
          teams={teams.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            endpoints.reload();
            if (result.discovered) setDiscovered({ name: result.endpoint.name, kind: result.endpoint.kind, ...result.discovered });
          }}
        />
      )}
      {discovered && <DiscoveredPopup info={discovered} onClose={() => setDiscovered(null)} />}
    </>
  );
}

function TestResult({ result }) {
  const items = result.models ?? result.tools ?? [];
  return (
    <>
      <span className={`badge ${result.ok ? 'passed' : 'failed'}`}>{result.ok ? `✓ ${result.latencyMs} ms` : '✕ Fehler'}</span>
      <div>{result.ok ? `${items.length} ${result.tools ? 'Tools' : 'Modelle'}: ${items.slice(0, 6).join(', ')}${items.length > 6 ? ' …' : ''}` : result.error?.slice(0, 120)}</div>
    </>
  );
}

// Kurzes Popup nach dem Anlegen: wie viele und welche Modelle wurden gelesen?
function DiscoveredPopup({ info, onClose }) {
  const isMcp = info.kind === 'mcp';
  return (
    <Modal
      title={`Endpoint ${info.name} gespeichert`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          OK
        </button>
      }
    >
      {isMcp ? (
        <p>MCP-Server gespeichert. Die Tools werden beim Verbindungstest abgefragt.</p>
      ) : info.skipped ? (
        <p>Die automatische Modellabfrage ist ausgeschaltet. Es wurden keine Modelle gelesen.</p>
      ) : info.ok ? (
        <>
          <p>
            <strong>{info.models.length}</strong> {info.models.length === 1 ? 'Modell wurde' : 'Modelle wurden'} vom Endpoint gelesen:
          </p>
          <div className="tags" style={{ maxHeight: 220, overflow: 'auto' }}>
            {info.models.map((m) => (
              <span key={m} className="tag">
                {m}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="error-box">Die Modelle konnten nicht gelesen werden: {info.error}</div>
      )}
    </Modal>
  );
}

function EndpointEditor({ endpoint, platform, teams, onClose, onSaved }) {
  const keys = useApi('/api/api-keys');
  const users = useUserDirectory();
  const [form, setForm] = useState({
    name: endpoint.name ?? '',
    kind: endpoint.kind ?? 'ai_proxy',
    llm_flavor: endpoint.llm_flavor ?? 'openai',
    base_url: endpoint.base_url ?? '',
    api_key_id: endpoint.api_key_id ?? '',
    maintainer_id: endpoint.maintainer_id ?? '',
    environment: endpoint.environment ?? 'prod',
    visibility: endpoint.visibility ?? 'global',
    manual_models: (endpoint.models ?? [])
      .filter((m) => m.source === 'manual')
      .map((m) => m.name)
      .join(', '),
    auto_discover: endpoint.auto_discover ?? true,
    default_model: endpoint.default_model ?? '',
    enabled: endpoint.enabled ?? true,
    notes: endpoint.notes ?? '',
  });
  const [teamIds, setTeamIds] = useState(endpoint.teamIds ?? []);
  const [headers, setHeaders] = useState(endpoint.headers ?? {});
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function runTest() {
    setTest({ pending: true });
    try {
      setTest(await api('/api/endpoints/test', { method: 'POST', body: { ...form, platform_id: platform.id, environment: platform.environment, api_key_id: form.api_key_id || null, headers } }));
    } catch (e) {
      setTest({ ok: false, error: e.message });
    }
  }

  async function save() {
    const body = {
      ...form,
      platform_id: platform.id,
      environment: platform.environment,
      api_key_id: form.api_key_id || null,
      maintainer_id: form.maintainer_id || null,
      teamIds,
      headers,
      manual_models: form.manual_models
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      onSaved(await api(endpoint.id ? `/api/endpoints/${endpoint.id}` : '/api/endpoints', { method: endpoint.id ? 'PUT' : 'POST', body }));
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
          <button className="btn" onClick={runTest} disabled={!form.base_url}>
            <PlugZap size={14} /> Verbindung testen
          </button>
          <span style={{ flex: 1 }} />
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
      {test && (
        <div className="hint" style={{ marginBottom: 12 }}>
          {test.pending ? 'Teste Verbindung…' : <TestResult result={test} />}
        </div>
      )}
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Maintainer</span>
          <select value={form.maintainer_id} onChange={(e) => set({ maintainer_id: e.target.value })}>
            <option value="">– keiner –</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Art</span>
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
            {Object.entries(KIND_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        {form.kind === 'llm' ? (
          <label className="field">
            <span>API-Art</span>
            <select value={form.llm_flavor} onChange={(e) => set({ llm_flavor: e.target.value })}>
              {FLAVORS.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div />
        )}
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
        <select value={form.api_key_id} onChange={(e) => set({ api_key_id: e.target.value })}>
          <option value="">– ohne Key (z. B. vLLM) –</option>
          {(keys.data ?? []).map((k) => (
            <option key={k.id} value={k.id}>
              {k.name} ({k.masked})
            </option>
          ))}
        </select>
        <div className="hint">Keys verwaltest du unter Verwaltung › Zugangsdaten.</div>
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Veröffentlicht für</span>
          <select value={form.visibility} onChange={(e) => set({ visibility: e.target.value })}>
            {Object.entries(PUBLISH_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      {form.visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}
      {form.kind !== 'mcp' && (
        <>
          <label className="checkbox" style={{ margin: '12px 0' }}>
            <input type="checkbox" checked={form.auto_discover} onChange={(e) => set({ auto_discover: e.target.checked })} /> Modelle automatisch
            abfragen (beim Speichern, beim Verbindungstest und alle 15 Minuten)
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Zusätzliche Modelle (manuell, kommagetrennt)</span>
              <input value={form.manual_models} placeholder="nur nötig ohne Modellliste" onChange={(e) => set({ manual_models: e.target.value })} />
            </label>
            <label className="field">
              <span>Standardmodell (Name oder Alias)</span>
              <input value={form.default_model} list="endpoint-models" onChange={(e) => set({ default_model: e.target.value })} />
              <datalist id="endpoint-models">
                {(endpoint.models ?? []).map((m) => (
                  <option key={m.name} value={m.alias ?? m.name} />
                ))}
              </datalist>
            </label>
          </div>
        </>
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
