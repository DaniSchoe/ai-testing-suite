import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
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

export default function Components({ platform, status, onChanged }) {
  const endpoints = useApi(`/api/endpoints?platform_id=${platform.id}`);
  const presets = useApi('/api/inventory/presets');
  const teams = useTeams();
  const [editing, setEditing] = useState(null);
  const [discovered, setDiscovered] = useState(null);
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';

  async function remove(e) {
    if (!confirm(`Komponente "${e.name}" löschen? Prüfungen mit dieser Komponente verlieren ihr Ziel.`)) return;
    await api(`/api/endpoints/${e.id}`, { method: 'DELETE' });
    endpoints.reload();
    onChanged?.();
  }

  const statusOf = new Map((status?.data?.components ?? []).map((c) => [c.endpoint_id, c]));
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
              <th>Version</th>
              <th>Veröffentlicht</th>
              <th>Verbindung</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const meta = KIND_META[e.kind];
              const live = statusOf.get(e.id);
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
                  <td className="sub">{live?.version ?? e.spec?.version_override ?? (e.kind === 'kubernetes' ? e.spec?.version : null) ?? '–'}</td>
                  <td>
                    <VisibilityBadge visibility={e.visibility} teamNames={e.teamIds.map(teamName)} />
                  </td>
                  <td className="sub">
                    <Connection live={live} />
                  </td>
                  <td className="num">
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
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

function Connection({ live }) {
  if (!live) return <span className="sub">–</span>;
  if (live.status === 'up') {
    return (
      <span className="conn up" title={`erreichbar${live.latency_ms ? `, ${live.latency_ms} ms` : ''}`}>
        <span className="dot blink" /> {fmt.ms(live.latency_ms)}
      </span>
    );
  }
  if (live.status === 'n/a') return <span className="sub">nicht überwacht</span>;
  return (
    <span className="conn down" title={live.error ?? 'nicht erreichbar'}>
      <span className="dot" /> gestört
    </span>
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

// Einklappbarer Bereich für optionale Angaben.
function Optional({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="optional">
      <button type="button" className="optional-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Optionale Angaben
      </button>
      {open && <div className="optional-body">{children}</div>}
    </div>
  );
}

const num = (set, key) => (v) => set({ [key]: v === '' ? null : Number(v) });

// Pflichtfelder (Rechenzentrum): Hosting-Anbieter, Standort, Land.
function DatacenterRequired({ spec, set, presets }) {
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
    </>
  );
}

function DatacenterOptional({ spec, set, presets }) {
  return (
    <>
      <CertificationPicker presets={presets} value={spec.certifications} onChange={(v) => set({ certifications: v })} />
      <div className="form-grid">
        <Pick label="Strom aus erneuerbaren Quellen" value={spec.renewable_energy === null || spec.renewable_energy === undefined ? '' : String(spec.renewable_energy)} onChange={(v) => set({ renewable_energy: v === '' ? null : v === 'true' })} options={[['', 'unbekannt'], ['true', 'ja'], ['false', 'nein']]} />
        <Text label="PUE (Energieeffizienz)" type="number" step="0.01" value={spec.pue} onChange={num(set, 'pue')} hint="z. B. 1,3; kleiner ist besser" />
      </div>
      <div className="form-grid">
        <Text label="CPU-Cores" type="number" min={0} value={spec.cpu_cores} onChange={num(set, 'cpu_cores')} />
        <Text label="RAM in GB" type="number" min={0} value={spec.ram_gb} onChange={num(set, 'ram_gb')} />
        <Text label="Speicher in TB" type="number" min={0} value={spec.storage_tb} onChange={num(set, 'storage_tb')} />
      </div>
    </>
  );
}

function KubernetesRequired({ spec, set, presets }) {
  const dist = spec.distribution ?? 'vanilla';
  return (
    <>
      <div className="form-grid">
        <Pick label="Betrieb" value={spec.operation ?? 'self_managed'} onChange={(v) => set({ operation: v })} options={[['self_managed', 'Selbst betrieben'], ['managed', 'Managed (vom Anbieter betrieben)']]} />
        <Pick label="Distribution" value={dist} onChange={(v) => set({ distribution: v, operation: presets.k8s_distributions.find((d) => d.key === v)?.managed ? 'managed' : spec.operation })} options={presets.k8s_distributions.map((d) => [d.key, d.label])} />
      </div>
      {dist === 'other' && <Text label="Name der Distribution" value={spec.distribution_name} onChange={(v) => set({ distribution_name: v })} />}
    </>
  );
}

function KubernetesOptional({ spec, set, presets }) {
  return (
    <>
      <Text label="Version" value={spec.version} onChange={(v) => set({ version: v })} placeholder="z. B. 1.31" />
      <CertificationPicker presets={presets} value={spec.certifications} onChange={(v) => set({ certifications: v })} />
      <Check checked={spec.cis_hardened === true} onChange={(v) => set({ cis_hardened: v })}>
        CIS-Härtung (CIS Kubernetes Benchmark umgesetzt)
      </Check>
    </>
  );
}

function ServerRequired({ spec, set, presets }) {
  return (
    <div className="form-grid">
      <Pick label="Server-Art" value={spec.server_type ?? 'cpu'} onChange={(v) => set({ server_type: v })} options={presets.server_types.map((t) => [t.key, t.label])} hint="Ein GPU-Server nimmt in der Topologie GPU-Cores auf." />
      <Text label="Modell / Bauart" value={spec.model} onChange={(v) => set({ model: v })} placeholder="z. B. Dell PowerEdge XE9680" />
    </div>
  );
}

function ServerOptional({ spec, set }) {
  return (
    <div className="form-grid">
      <Text label="CPU-Cores" type="number" min={0} value={spec.cpu_cores} onChange={num(set, 'cpu_cores')} />
      <Text label="RAM in GB" type="number" min={0} value={spec.ram_gb} onChange={num(set, 'ram_gb')} />
      <Text label="Speicher in TB" type="number" min={0} value={spec.storage_tb} onChange={num(set, 'storage_tb')} />
    </div>
  );
}

function InterconnectRequired({ spec, set, presets }) {
  return <Pick label="Technik" value={spec.type ?? 'nvlink'} onChange={(v) => set({ type: v })} options={presets.interconnect_types.map((t) => [t.key, t.label])} hint="Die GPU-Bundles legst du in der Topologie an." />;
}

function GpuRequired({ spec, set, presets }) {
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

function InferenceRequired({ spec, set, presets }) {
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

function GatewayRequired({ spec, set, presets }) {
  return (
    <div className="form-grid">
      <Pick label="Produkt" value={spec.product ?? 'litellm'} onChange={(v) => set({ product: v })} options={presets.gateway_products.map((p) => [p.key, p.label])} />
      {spec.product === 'other' && <Text label="Name des Produkts" value={spec.product_name} onChange={(v) => set({ product_name: v })} />}
      <Text label="Instanzen" type="number" min={1} value={spec.instances ?? 1} onChange={(v) => set({ instances: Number(v) || 1 })} hint="Mehrere Instanzen erhöhen die Ausfallsicherheit." />
    </div>
  );
}

// Erkannte Version nach Eingabe der URL (Inferenzserver, AI Gateway).
function VersionField({ spec, set, detected }) {
  return (
    <Text
      label="Version (überschreiben)"
      value={spec.version_override}
      onChange={(v) => set({ version_override: v })}
      placeholder={detected?.version ?? 'automatisch'}
      hint={
        detected?.pending
          ? 'Version wird abgefragt…'
          : detected?.version
            ? `Erkannte Version: ${detected.version}. Ein eingetragener Wert hat Vorrang.`
            : detected
              ? 'Version konnte nicht ermittelt werden. Trage sie bei Bedarf hier ein.'
              : 'Wird nach Eingabe der URL automatisch ermittelt.'
      }
    />
  );
}

const VERSION_KINDS = ['vector_db', 'iam', 'observability'];

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
  const [bearer, setBearer] = useState('');
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);
  const [detected, setDetected] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setSpec = (patch) => setSpecState((s) => ({ ...s, ...patch }));
  const kind = form.kind;
  const urlKind = URL_KINDS.includes(kind);
  const managed = kind === 'llm' && presets.inference_providers.find((p) => p.key === (spec.provider ?? 'vllm'))?.hosting === 'managed';
  const hasModels = ['llm', 'ai_proxy'].includes(kind);
  const selfInference = kind === 'llm' && !managed;
  const keyed = ['llm', 'ai_proxy'].includes(kind);
  const mcpAuth = spec.auth?.type ?? 'none';
  const hasVersion = ['llm', 'ai_proxy', ...VERSION_KINDS].includes(kind);

  // Pflichtangaben je Art; der Maintainer ist bei Inferenzserver, Rechenzentrum und Server Pflicht.
  const maintainerRequired = ['llm', 'datacenter', 'server'].includes(kind);
  const missing =
    !form.name.trim() ||
    (urlKind && !form.base_url.trim()) ||
    (maintainerRequired && !form.maintainer_id) ||
    (kind === 'datacenter' && (!spec.region?.trim() || !spec.country?.trim())) ||
    (kind === 'server' && !spec.model?.trim());

  const payload = () => ({
    ...form,
    platform_id: platform.id,
    environment: platform.environment,
    api_key_id: keyed ? form.api_key_id || null : null,
    maintainer_id: form.maintainer_id || null,
    metrics_url: form.metrics_url || null,
    base_url: urlKind ? form.base_url : null,
    spec: kind === 'mcp' ? { ...spec, auth: { type: mcpAuth } } : spec,
    bearer_token: kind === 'mcp' && mcpAuth === 'bearer' && bearer ? bearer : undefined,
    teamIds,
    headers,
    manual_models: form.manual_models
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });

  // Version abfragen, sobald die URL eingegeben wurde (Inferenzserver und AI Gateway).
  async function probeVersion() {
    if (!['llm', 'ai_proxy'].includes(kind) || !form.base_url.trim()) return;
    try {
      new URL(form.base_url);
    } catch {
      return;
    }
    setDetected({ pending: true });
    try {
      const r = await api('/api/endpoints/probe', { method: 'POST', body: { kind, base_url: form.base_url, api_key_id: form.api_key_id || null, headers } });
      setDetected({ version: r.version, status: r.status });
    } catch {
      setDetected({ version: null });
    }
  }

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

  const Maintainer = (
    <label className="field">
      <span>Maintainer</span>
      <select value={form.maintainer_id} onChange={(e) => set({ maintainer_id: e.target.value })}>
        <option value="">– {maintainerRequired ? 'bitte wählen' : 'keiner'} –</option>
        {(users.data ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    </label>
  );

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
          <button className="btn primary" onClick={save} disabled={missing}>
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
            setDetected(null);
          }}
          options={KIND_ORDER.map((k) => [k, KIND_META[k].label])}
          hint={KIND_HINT[kind]}
        />
        <Text label="Name" value={form.name} onChange={(v) => set({ name: v })} />
      </div>

      {kind === 'datacenter' && <DatacenterRequired spec={spec} set={setSpec} presets={presets} />}
      {kind === 'kubernetes' && <KubernetesRequired spec={spec} set={setSpec} presets={presets} />}
      {kind === 'server' && <ServerRequired spec={spec} set={setSpec} presets={presets} />}
      {kind === 'interconnect' && <InterconnectRequired spec={spec} set={setSpec} presets={presets} />}
      {kind === 'gpu' && <GpuRequired spec={spec} set={setSpec} presets={presets} />}
      {kind === 'llm' && <InferenceRequired spec={spec} set={setSpec} presets={presets} />}
      {kind === 'ai_proxy' && <GatewayRequired spec={spec} set={setSpec} presets={presets} />}

      {urlKind && (
        <Text
          label="Endpunkt (Basis-URL)"
          type="url"
          value={form.base_url}
          placeholder={kind === 'mcp' ? 'https://litellm.example.com/mcp' : 'https://litellm.example.com'}
          onChange={(v) => {
            set({ base_url: v });
            setDetected(null);
          }}
          onBlur={probeVersion}
          hint={kind === 'mcp' ? 'Vollständige URL des MCP-Endpunkts (Streamable HTTP).' : 'Ohne /v1, z. B. http://vllm.ai.svc.cluster.local:8000 für einen Service im Cluster.'}
        />
      )}
      {kind === 'ai_proxy' && (
        <label className="field">
          <span>API-Key</span>
          <select value={form.api_key_id} onChange={(e) => set({ api_key_id: e.target.value })} onBlur={probeVersion}>
            <option value="">– ohne Key –</option>
            {(keys.data ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.masked})
              </option>
            ))}
          </select>
          <div className="hint">Keys verwaltest du unter Plattform › Keys.</div>
        </label>
      )}
      {kind === 'mcp' && (
        <>
          <Pick label="Authentifizierung" value={mcpAuth} onChange={(v) => setSpec({ auth: { type: v } })} options={[['none', 'Keine'], ['bearer', 'Bearer Token'], ['oidc', 'OIDC']]} hint="Ein MCP-Server ohne Authentifizierung gilt in der Einstufung als Schwäche." />
          {mcpAuth === 'bearer' && (
            <Text
              label="Bearer Token"
              type="password"
              autoComplete="new-password"
              value={bearer}
              onChange={setBearer}
              placeholder={endpoint.id ? '(unverändert)' : ''}
              hint="Wird verschlüsselt gespeichert."
            />
          )}
        </>
      )}
      <div className="form-grid">
        {Maintainer}
        <Pick label="Veröffentlicht für" value={form.visibility} onChange={(v) => set({ visibility: v })} options={Object.entries(PUBLISH_LABEL)} />
      </div>
      {form.visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}

      <Optional>
        {kind === 'datacenter' && <DatacenterOptional spec={spec} set={setSpec} presets={presets} />}
        {kind === 'kubernetes' && <KubernetesOptional spec={spec} set={setSpec} presets={presets} />}
        {kind === 'server' && <ServerOptional spec={spec} set={setSpec} />}
        {kind === 'llm' && (
          <Pick
            label="Erreichbarkeit"
            value={spec.reachability ?? ''}
            onChange={(v) => setSpec({ reachability: v || undefined })}
            options={[['', 'nicht angegeben'], ['gateway_only', 'nur intern über das AI Gateway'], ['direct', 'direkt erreichbar']]}
            hint="Fließt in die Souveränitätsziele ein: Ein Inferenzserver, der nur über das Gateway erreichbar ist, gilt als besser abgeschirmt."
          />
        )}
        {hasVersion && <VersionField spec={spec} set={setSpec} detected={['llm', 'ai_proxy'].includes(kind) ? detected : undefined} />}
        {(kind === 'gpu' || kind === 'ai_proxy' || selfInference) && (
          <Text
            label={kind === 'gpu' ? 'Metrics-Endpunkt (DCGM)' : 'Metrics-Endpunkt'}
            type="url"
            value={form.metrics_url}
            placeholder={kind === 'gpu' ? 'http://dcgm-exporter:9400/metrics' : kind === 'ai_proxy' ? 'http://litellm:4000/metrics' : 'http://vllm:8000/metrics'}
            onChange={(v) => set({ metrics_url: v })}
            hint="Prometheus-Endpunkt; damit gilt die Komponente als überwacht und erscheint unter Metriken."
          />
        )}
        {kind === 'llm' && (
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
        )}
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
      </Optional>
    </Modal>
  );
}
