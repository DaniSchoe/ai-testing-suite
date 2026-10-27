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

const KIND_ORDER = ['datacenter', 'server', 'gpu', 'interconnect', 'kubernetes', 'llm', 'ai_proxy', 'mcp', 'vector_db', 'iam', 'observability'];
const URL_KINDS = ['llm', 'ai_proxy', 'mcp', 'vector_db', 'iam', 'observability'];
const KIND_HINT = {
  datacenter: 'Rechenzentrum bzw. Hosting-Anbieter, in dem die Plattform läuft.',
  kubernetes: 'Kubernetes-Cluster, auf dem Inferenzserver und Gateway laufen.',
  server: 'Physischer Server (CPU oder GPU). GPU-Cores werden in der Topologie am Server hinzugefügt.',
  gpu: 'GPU-Cores einer Karte bzw. eines Beschleunigers. Jede GPU legst du als eigenen Eintrag an und weist sie in der Topologie einem Server zu; Bundles (NVLink, MIG) bildest du im Interconnect.',
  interconnect: 'Verbindung zwischen GPUs, z. B. NVLink. Darin bildest du benannte GPU-Bundles.',
  llm: 'Inferenzserver: selbst betrieben (z. B. vLLM) oder ein genutzter Managed Service (z. B. ChatGPT, Claude).',
  ai_proxy: 'AI Gateway, über das Anwendungen die Modelle ansprechen (z. B. LiteLLM).',
  mcp: 'MCP-Server der Plattform.',
  vector_db: 'Vektor-Datenbank für RAG.',
  iam: 'Identitätsmanagement (z. B. Keycloak).',
  observability: 'Monitoring und Protokollierung.',
};

const label = (list, key) => list?.find((x) => x.key === key)?.label ?? key;

// Kurzbeschreibung einer Komponente je Art.
function summary(e, presets) {
  const s = e.spec ?? {};
  if (e.kind === 'datacenter') return [label(presets?.hosting_providers, s.provider), [s.region, s.country].filter(Boolean).join(', '), (s.certifications ?? []).join(', '), s.ram_gb ? `${s.ram_gb} GB RAM` : null].filter(Boolean).join(' · ');
  if (e.kind === 'server') return [s.server_type === 'gpu' ? 'GPU-Server' : 'CPU-Server', s.model, s.cpu_cores ? `${s.cpu_cores} Cores` : null, s.ram_gb ? `${s.ram_gb} GB RAM` : null].filter(Boolean).join(' · ');
  if (e.kind === 'interconnect') return [label(presets?.interconnect_types, s.type), (s.bundles ?? []).length ? `${s.bundles.length} Bundles` : null].filter(Boolean).join(' · ');
  if (e.kind === 'kubernetes') return [s.operation === 'managed' ? 'Managed' : 'Selbst betrieben', label(presets?.k8s_distributions, s.distribution), s.version].filter(Boolean).join(' · ');
  if (e.kind === 'gpu') {
    const g = presets?.gpu_types?.[s.gpu_type];
    return [s.gpu_type === 'custom' ? s.custom?.name : (g?.label ?? s.gpu_type), `${s.memory_gb ?? '?'} GB`, s.mig?.enabled ? `MIG: ${s.mig.layout.map((l) => l.profile).join(', ')}` : null].filter(Boolean).join(' · ');
  }
  if (e.kind === 'llm') return [label(presets?.inference_providers, s.provider), s.hosting === 'managed' ? 'Managed Service' : 'selbst betrieben'].filter(Boolean).join(' · ');
  if (e.kind === 'ai_proxy') return [label(presets?.gateway_products, s.product), s.instances > 1 ? `${s.instances} Instanzen` : null].filter(Boolean).join(' · ');
  return e.base_url ?? '';
}

export default function Components({ platform, onChanged }) {
  const endpoints = useApi(`/api/endpoints?platform_id=${platform.id}`);
  const presets = useApi('/api/inventory/presets');
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
    onChanged?.();
  }

  async function remove(e) {
    if (!confirm(`Komponente "${e.name}" löschen? Prüfungen mit dieser Komponente verlieren ihr Ziel.`)) return;
    await api(`/api/endpoints/${e.id}`, { method: 'DELETE' });
    endpoints.reload();
    onChanged?.();
  }

  const rows = [...(endpoints.data ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));

  return (
    <>
      <div className="toolbar">
        <span className="hint" style={{ flex: 1 }}>
          Inventar der Plattform: Rechenzentrum, Server, GPU, Interconnect, Kubernetes, Inferenzserver, AI Gateway und weitere Dienste. Wie sie zusammenhängen, legst du im Tab Topologie fest. Den API-Key wählst du unter{' '}
          <Link to="/credentials">Keys</Link>.
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
              <th>Angaben</th>
              <th>Modelle</th>
              <th>Veröffentlicht</th>
              <th>Verbindung</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const c = checks[e.id];
              const meta = KIND_META[e.kind];
              const urlKind = URL_KINDS.includes(e.kind);
              return (
                <tr key={e.id}>
                  <td style={{ minWidth: 220 }}>
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
                    <KindBadge kind={e.kind} flavor={e.kind === 'llm' ? e.llm_flavor : undefined} />
                  </td>
                  <td className="sub">{summary(e, presets.data)}</td>
                  <td className="sub">
                    {!['llm', 'ai_proxy'].includes(e.kind) ? (
                      '–'
                    ) : (
                      <>
                        <Link to="/models">{e.models.filter((m) => m.available).length} gefunden</Link>
                        {e.models.some((m) => !m.available) && <span> · {e.models.filter((m) => !m.available).length} verschwunden</span>}
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
                      {(urlKind || e.metrics_url) && (
                        <button className="btn sm" onClick={() => check(e)}>
                          <PlugZap size={13} /> Testen
                        </button>
                      )}
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
                  Noch keine Komponenten. Beginne mit dem Rechenzentrum, dann Server, GPUs, Kubernetes, Inferenzserver und Gateway.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && presets.data && (
        <EndpointEditor
          endpoint={editing}
          platform={platform}
          presets={presets.data}
          teams={teams.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            endpoints.reload();
            onChanged?.();
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
      <div>{result.note ?? (result.ok ? `${items.length} ${result.tools ? 'Tools' : 'Modelle'}: ${items.slice(0, 6).join(', ')}${items.length > 6 ? ' …' : ''}` : result.error?.slice(0, 120))}</div>
    </>
  );
}

// Kurzes Popup nach dem Anlegen: wie viele und welche Modelle wurden gefunden? Sie erscheinen erst im Modellportfolio, wenn du sie dort auswählst.
function DiscoveredPopup({ info, onClose }) {
  const hasModels = ['llm', 'ai_proxy'].includes(info.kind);
  return (
    <Modal
      title={`${info.name} gespeichert`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          OK
        </button>
      }
    >
      {!hasModels ? (
        <p>Komponente gespeichert.</p>
      ) : info.skipped ? (
        <p>Die automatische Modellabfrage ist ausgeschaltet. Es wurden keine Modelle gelesen.</p>
      ) : info.ok ? (
        <>
          <p>
            <strong>{info.models.length}</strong> {info.models.length === 1 ? 'Modell wurde' : 'Modelle wurden'} gefunden. Sie werden erst getestet, wenn du sie im <Link to="/models">Modellportfolio</Link> auswählst:
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

export const Check = ({ checked, onChange, children }) => (
  <label className="checkbox">
    <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} /> {children}
  </label>
);

export function Text({ label: text, value, onChange, hint, ...rest }) {
  return (
    <label className="field">
      <span>{text}</span>
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />
      {hint && <div className="hint">{hint}</div>}
    </label>
  );
}

export function Pick({ label: text, value, onChange, options, hint }) {
  return (
    <label className="field">
      <span>{text}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {options.map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      {hint && <div className="hint">{hint}</div>}
    </label>
  );
}

function CertificationPicker({ presets, value = [], onChange }) {
  const set = new Set(value);
  const extra = value.filter((c) => !presets.certifications.includes(c));
  return (
    <div className="field">
      <span>Zertifizierungen</span>
      <div className="pick-list" style={{ maxHeight: 140 }}>
        {presets.certifications.map((c) => (
          <label key={c}>
            <input type="checkbox" checked={set.has(c)} onChange={() => onChange(set.has(c) ? value.filter((x) => x !== c) : [...value, c])} />
            <span>{c}</span>
          </label>
        ))}
      </div>
      <input placeholder="Weitere, kommagetrennt" value={extra.join(', ')} onChange={(e) => onChange([...value.filter((c) => presets.certifications.includes(c)), ...e.target.value.split(',').map((x) => x.trim()).filter(Boolean)])} />
    </div>
  );
}

function DatacenterFields({ spec, set, presets }) {
  return (
    <>
      <div className="form-grid">
        <Pick label="Hosting-Anbieter" value={spec.provider ?? 'on_prem'} onChange={(v) => set({ provider: v, on_prem: v === 'on_prem' })} options={presets.hosting_providers.map((p) => [p.key, p.label])} />
        {spec.provider === 'other' && <Text label="Name des Anbieters" value={spec.provider_name} onChange={(v) => set({ provider_name: v })} />}
      </div>
      <div className="form-grid">
        <Text label="Region / Standort" value={spec.region} onChange={(v) => set({ region: v })} placeholder="z. B. Frankfurt" />
        <Text label="Land (ISO-Code)" value={spec.country} maxLength={2} onChange={(v) => set({ country: v.toUpperCase() })} placeholder="DE" />
      </div>
      <CertificationPicker presets={presets} value={spec.certifications} onChange={(v) => set({ certifications: v })} />
      <div className="form-grid">
        <Pick label="Strom aus erneuerbaren Quellen" value={spec.renewable_energy === null || spec.renewable_energy === undefined ? '' : String(spec.renewable_energy)} onChange={(v) => set({ renewable_energy: v === '' ? null : v === 'true' })} options={[['', 'unbekannt'], ['true', 'ja'], ['false', 'nein']]} />
        <Text label="PUE (Energieeffizienz)" type="number" step="0.01" value={spec.pue} onChange={(v) => set({ pue: v === '' ? null : Number(v) })} hint="z. B. 1,3; kleiner ist besser" />
      </div>
      <div className="form-grid">
        <Text label="CPU-Cores (optional)" type="number" min={0} value={spec.cpu_cores} onChange={(v) => set({ cpu_cores: v === '' ? null : Number(v) })} />
        <Text label="RAM in GB (optional)" type="number" min={0} value={spec.ram_gb} onChange={(v) => set({ ram_gb: v === '' ? null : Number(v) })} />
        <Text label="Speicher in TB (optional)" type="number" min={0} value={spec.storage_tb} onChange={(v) => set({ storage_tb: v === '' ? null : Number(v) })} />
      </div>
    </>
  );
}

function KubernetesFields({ spec, set, presets }) {
  const dist = spec.distribution ?? 'vanilla';
  return (
    <>
      <div className="form-grid">
        <Pick label="Betrieb" value={spec.operation ?? 'self_managed'} onChange={(v) => set({ operation: v })} options={[['self_managed', 'Selbst betrieben'], ['managed', 'Managed (vom Anbieter betrieben)']]} />
        <Pick label="Distribution" value={dist} onChange={(v) => set({ distribution: v, operation: presets.k8s_distributions.find((d) => d.key === v)?.managed ? 'managed' : spec.operation })} options={presets.k8s_distributions.map((d) => [d.key, d.label])} />
      </div>
      {dist === 'other' && <Text label="Name der Distribution" value={spec.distribution_name} onChange={(v) => set({ distribution_name: v })} />}
      <Text label="Version" value={spec.version} onChange={(v) => set({ version: v })} placeholder="z. B. 1.31" />
      <CertificationPicker presets={presets} value={spec.certifications} onChange={(v) => set({ certifications: v })} />
    </>
  );
}

function ServerFields({ spec, set, presets }) {
  return (
    <>
      <div className="form-grid">
        <Pick label="Server-Art" value={spec.server_type ?? 'cpu'} onChange={(v) => set({ server_type: v })} options={presets.server_types.map((t) => [t.key, t.label])} hint="Ein GPU-Server nimmt in der Topologie GPU-Cores auf." />
        <Text label="Modell / Bauart (optional)" value={spec.model} onChange={(v) => set({ model: v })} placeholder="z. B. Dell PowerEdge XE9680" />
      </div>
      <div className="form-grid">
        <Text label="CPU-Cores" type="number" min={0} value={spec.cpu_cores} onChange={(v) => set({ cpu_cores: v === '' ? null : Number(v) })} />
        <Text label="RAM in GB" type="number" min={0} value={spec.ram_gb} onChange={(v) => set({ ram_gb: v === '' ? null : Number(v) })} />
        <Text label="Speicher in TB" type="number" min={0} value={spec.storage_tb} onChange={(v) => set({ storage_tb: v === '' ? null : Number(v) })} />
      </div>
    </>
  );
}

function InterconnectFields({ spec, set, presets }) {
  return <Pick label="Technik" value={spec.type ?? 'nvlink'} onChange={(v) => set({ type: v })} options={presets.interconnect_types.map((t) => [t.key, t.label])} hint="Die GPU-Bundles legst du in der Topologie an." />;
}

function GpuFields({ spec, set, presets }) {
  const type = spec.gpu_type ?? 'h100';
  const preset = presets.gpu_types[type];
  const custom = spec.custom ?? {};
  return (
    <>
      <Pick label="GPU-Typ" value={type} onChange={(v) => set({ gpu_type: v, mig: { enabled: false, layout: [] } })} options={[...Object.entries(presets.gpu_types).map(([k, g]) => [k, `${g.label} (${g.memory_gb} GB)`]), ['custom', 'Eigener GPU-Typ']]} />
      {preset?.approximate && <div className="hint">Die MIG-Profile dieser GPU sind abgeleitet; bitte gegen das Datenblatt prüfen.</div>}
      {type === 'custom' && (
        <div className="form-grid">
          <Text label="Bezeichnung" value={custom.name} onChange={(v) => set({ custom: { ...custom, name: v } })} placeholder="z. B. AMD MI300X" />
          <Text label="Hersteller" value={custom.vendor} onChange={(v) => set({ custom: { ...custom, vendor: v } })} />
          <Text label="Speicher (GB)" type="number" value={custom.memory_gb} onChange={(v) => set({ custom: { ...custom, memory_gb: Number(v) || '' } })} />
          <Text label="Max. Slices bei MIG" type="number" min={1} max={7} value={custom.max_mig_slices ?? 7} onChange={(v) => set({ custom: { ...custom, max_mig_slices: Number(v) || 1 } })} />
          <Check checked={custom.mig_capable} onChange={(v) => set({ custom: { ...custom, mig_capable: v } })}>
            unterstützt MIG
          </Check>
          <Text label="Weitere Metadaten" value={custom.notes} onChange={(v) => set({ custom: { ...custom, notes: v } })} />
        </div>
      )}
    </>
  );
}

function InferenceFields({ spec, set, presets }) {
  const provider = spec.provider ?? 'vllm';
  const self = presets.inference_providers.filter((p) => p.hosting === 'self');
  const managed = presets.inference_providers.filter((p) => p.hosting === 'managed');
  return (
    <>
      <label className="field">
        <span>Anbieter</span>
        <select value={provider} onChange={(e) => set({ provider: e.target.value })}>
          <optgroup label="Selbst betrieben">
            {self.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Managed Service (genutzt)">
            {managed.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {provider.startsWith('other') && <Text label="Name des Anbieters" value={spec.provider_name} onChange={(v) => set({ provider_name: v })} />}
    </>
  );
}

function GatewayFields({ spec, set, presets }) {
  return (
    <div className="form-grid">
      <Pick label="Produkt" value={spec.product ?? 'litellm'} onChange={(v) => set({ product: v })} options={presets.gateway_products.map((p) => [p.key, p.label])} />
      {spec.product === 'other' && <Text label="Name des Produkts" value={spec.product_name} onChange={(v) => set({ product_name: v })} />}
      <Text label="Instanzen" type="number" min={1} value={spec.instances ?? 1} onChange={(v) => set({ instances: Number(v) || 1 })} hint="Mehrere Instanzen erhöhen die Ausfallsicherheit." />
    </div>
  );
}

function EndpointEditor({ endpoint, platform, presets, teams, onClose, onSaved }) {
  const keys = useApi('/api/api-keys');
  const users = useUserDirectory();
  const [form, setForm] = useState({
    name: endpoint.name ?? '',
    kind: endpoint.kind ?? 'datacenter',
    llm_flavor: endpoint.llm_flavor ?? 'openai',
    base_url: endpoint.base_url ?? '',
    metrics_url: endpoint.metrics_url ?? '',
    api_key_id: endpoint.api_key_id ?? '',
    maintainer_id: endpoint.maintainer_id ?? '',
    visibility: endpoint.visibility ?? 'global',
    manual_models: (endpoint.models ?? [])
      .filter((m) => m.source === 'manual')
      .map((m) => m.name)
      .join(', '),
    auto_discover: endpoint.auto_discover ?? true,
    default_model: endpoint.default_model ?? '',
    enabled: endpoint.enabled ?? true,
    notes: endpoint.notes ?? '',
    health_path: endpoint.health_path ?? '',
  });
  const [spec, setSpecState] = useState(endpoint.spec ?? {});
  const [teamIds, setTeamIds] = useState(endpoint.teamIds ?? []);
  const [headers, setHeaders] = useState(endpoint.headers ?? {});
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setSpec = (patch) => setSpecState((s) => ({ ...s, ...patch }));
  const kind = form.kind;
  const urlKind = URL_KINDS.includes(kind);
  const managed = kind === 'llm' && presets.inference_providers.find((p) => p.key === (spec.provider ?? 'vllm'))?.hosting === 'managed';
  const hasModels = ['llm', 'ai_proxy'].includes(kind);
  const selfInference = kind === 'llm' && !managed;

  const payload = () => ({
    ...form,
    platform_id: platform.id,
    environment: platform.environment,
    api_key_id: form.api_key_id || null,
    maintainer_id: form.maintainer_id || null,
    metrics_url: form.metrics_url || null,
    base_url: urlKind ? form.base_url : null,
    spec,
    teamIds,
    headers,
    manual_models: form.manual_models
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });

  async function runTest() {
    setTest({ pending: true });
    try {
      setTest(await api('/api/endpoints/test', { method: 'POST', body: payload() }));
    } catch (e) {
      setTest({ ok: false, error: e.message });
    }
  }

  async function save() {
    try {
      onSaved(await api(endpoint.id ? `/api/endpoints/${endpoint.id}` : '/api/endpoints', { method: endpoint.id ? 'PUT' : 'POST', body: payload() }));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={endpoint.id ? 'Komponente bearbeiten' : 'Neue Komponente'}
      onClose={onClose}
      footer={
        <>
          {(urlKind || form.metrics_url) && (
            <button className="btn" onClick={runTest} disabled={urlKind ? !form.base_url : !form.metrics_url}>
              <PlugZap size={14} /> Verbindung testen
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save} disabled={!form.name.trim()}>
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
        <Pick
          label="Art"
          value={kind}
          onChange={(v) => {
            setForm((f) => ({ ...f, kind: v }));
            setSpecState({});
          }}
          options={KIND_ORDER.map((k) => [k, KIND_META[k].label])}
          hint={KIND_HINT[kind]}
        />
        <Text label="Name" value={form.name} onChange={(v) => set({ name: v })} />
      </div>

      {kind === 'datacenter' && <DatacenterFields spec={spec} set={setSpec} presets={presets} />}
      {kind === 'kubernetes' && <KubernetesFields spec={spec} set={setSpec} presets={presets} />}
      {kind === 'server' && <ServerFields spec={spec} set={setSpec} presets={presets} />}
      {kind === 'interconnect' && <InterconnectFields spec={spec} set={setSpec} presets={presets} />}
      {kind === 'gpu' && <GpuFields spec={spec} set={setSpec} presets={presets} />}
      {kind === 'llm' && <InferenceFields spec={spec} set={setSpec} presets={presets} />}
      {kind === 'ai_proxy' && <GatewayFields spec={spec} set={setSpec} presets={presets} />}

      {urlKind && (
        <>
          <Text
            label="Endpunkt (Basis-URL)"
            type="url"
            value={form.base_url}
            placeholder={kind === 'mcp' ? 'https://litellm.example.com/mcp' : 'https://litellm.example.com'}
            onChange={(v) => set({ base_url: v })}
            hint={kind === 'mcp' ? 'Vollständige URL des MCP-Endpunkts (Streamable HTTP).' : 'Ohne /v1, z. B. http://vllm.ai.svc.cluster.local:8000 für einen Service im Cluster.'}
          />
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
            <div className="hint">Keys verwaltest du unter Plattform › Keys.{managed && ' Managed Services brauchen in der Regel einen Key.'}</div>
          </label>
        </>
      )}
      {(kind === 'gpu' || selfInference) && (
        <Text
          label={kind === 'gpu' ? 'Metrics-Endpunkt (DCGM, optional)' : 'Metrics-Endpunkt (optional)'}
          type="url"
          value={form.metrics_url}
          placeholder={kind === 'gpu' ? 'http://dcgm-exporter:9400/metrics' : 'http://vllm:8000/metrics'}
          onChange={(v) => set({ metrics_url: v })}
          hint="Prometheus-Endpunkt; damit gilt die Komponente als überwacht."
        />
      )}
      <div className="form-grid">
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
        <Pick label="Veröffentlicht für" value={form.visibility} onChange={(v) => set({ visibility: v })} options={Object.entries(PUBLISH_LABEL)} />
      </div>
      {form.visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}
      {hasModels && (
        <>
          <Check checked={form.auto_discover} onChange={(v) => set({ auto_discover: v })}>
            Modelle automatisch abfragen (beim Speichern, beim Verbindungstest und alle 15 Minuten)
          </Check>
          <div className="hint" style={{ marginBottom: 8 }}>
            Gefundene Modelle werden erst im Modellportfolio ausgewählt und dann getestet.
          </div>
          <div className="form-grid">
            <Text label="Zusätzliche Modelle (manuell, kommagetrennt)" value={form.manual_models} placeholder="nur nötig ohne Modellliste" onChange={(v) => set({ manual_models: v })} />
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
      {urlKind && <JsonField label="Zusätzliche Header (JSON)" value={headers} rows={3} onChange={(v, ok) => ok && setHeaders(v)} />}
      <Text label="Notiz" value={form.notes} onChange={(v) => set({ notes: v })} />
      <Check checked={form.enabled} onChange={(v) => set({ enabled: v })}>
        aktiv
      </Check>
    </Modal>
  );
}
