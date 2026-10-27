// Konfigurationsleiste unter der Ebene: je Komponentenart die Angaben, die in der Topologie gepflegt werden.
import { Plus, Trash2 } from 'lucide-react';
import { Check, Pick, Text } from '../pages/admin/Components.jsx';

const num = (v) => (v === '' ? null : Number(v));
const gpuName = (g) => g.name;

function Row({ children, onRemove, label }) {
  return (
    <div className="cfg-row">
      {children}
      {onRemove && (
        <button className="btn sm ghost danger" onClick={onRemove} aria-label={label ?? 'Entfernen'}>
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function DatacenterConfig({ node, m }) {
  const s = node.spec ?? {};
  return (
    <div className="form-grid">
      <Text label="CPU-Cores (optional)" type="number" min={0} value={s.cpu_cores} onChange={(v) => m.setSpec(node.id, { cpu_cores: num(v) })} />
      <Text label="RAM in GB (optional)" type="number" min={0} value={s.ram_gb} onChange={(v) => m.setSpec(node.id, { ram_gb: num(v) })} />
      <Text label="Speicher in TB (optional)" type="number" min={0} value={s.storage_tb} onChange={(v) => m.setSpec(node.id, { storage_tb: num(v) })} />
    </div>
  );
}

function ServerConfig({ node, m }) {
  const gpuServer = node.spec?.server_type === 'gpu';
  const mine = m.gpusOf(node.id);
  const free = m.endpoints.filter((e) => e.kind === 'gpu' && !m.hostOf(e.id));
  const dcs = m.placedOf('datacenter');
  return (
    <>
      <div className="form-grid">
        <Pick
          label="Steht im Rechenzentrum"
          value={m.datacenterOf(node.id) ?? ''}
          onChange={(v) => m.setDatacenter(node.id, v || null)}
          options={[['', '– keinem –'], ...dcs.map((d) => [d.id, d.name])]}
          hint={dcs.length ? undefined : 'Füge oben der Ebene Rechenzentrum eines hinzu.'}
        />
        <div className="field">
          <span>Ausstattung</span>
          <div className="sub">
            {node.spec?.server_type === 'gpu' ? 'GPU-Server' : 'CPU-Server'}
            {node.spec?.cpu_cores ? ` · ${node.spec.cpu_cores} CPU-Cores` : ''}
            {node.spec?.ram_gb ? ` · ${node.spec.ram_gb} GB RAM` : ''}
            {node.spec?.storage_tb ? ` · ${node.spec.storage_tb} TB` : ''}
          </div>
        </div>
      </div>
      {gpuServer ? (
        <div className="field">
          <span>GPU-Cores in diesem Server ({mine.length})</span>
          {mine.map((g) => (
            <Row key={g.id} onRemove={() => m.removeGpu(g.id)} label={`${g.name} entfernen`}>
              <span>{gpuName(g)}</span> <span className="sub">{m.gpuLabel(g)}</span>
            </Row>
          ))}
          <div className="cfg-row">
            <select value="" onChange={(e) => e.target.value && m.addGpu(node.id, e.target.value)} aria-label="GPU hinzufügen">
              <option value="">{free.length ? 'GPU aus dem Inventar hinzufügen…' : 'Keine freie GPU im Inventar'}</option>
              {free.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({m.gpuLabel(g)})
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <div className="hint">Nur GPU-Server nehmen GPU-Cores auf. Die Server-Art änderst du im Inventar.</div>
      )}
    </>
  );
}

function InterconnectConfig({ node, m }) {
  const bundles = node.spec?.bundles ?? [];
  const gpus = m.endpoints.filter((e) => e.kind === 'gpu');
  const setBundles = (next) => m.setSpec(node.id, { bundles: next });
  const update = (i, patch) => setBundles(bundles.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const used = new Map();
  for (const ic of m.endpoints.filter((e) => e.kind === 'interconnect')) {
    for (const b of ic.spec?.bundles ?? []) if (b.mode === 'mig') for (const g of b.gpu_ids) used.set(g, (used.get(g) ?? 0) + (b.slices || 0));
  }
  return (
    <>
      <div className="hint" style={{ marginBottom: 8 }}>
        GPU-Bundles: NVLink fasst die GPU-Cores mehrerer GPUs zu einer virtuellen größeren GPU zusammen, MIG teilt eine GPU in kleinere Teile.
      </div>
      {bundles.map((b, i) => {
        const gpu = gpus.find((g) => g.id === b.gpu_ids[0]);
        const preset = gpu && m.presets.gpu_types[gpu.spec?.gpu_type];
        const profiles = preset?.mig ?? [];
        return (
          <div key={b.id} className="cfg-bundle">
            <div className="form-grid">
              <Text label="Name des Bundles" value={b.name} onChange={(v) => update(i, { name: v })} />
              <Pick label="Art" value={b.mode} onChange={(v) => update(i, { mode: v, gpu_ids: [], profile: null, slices: null, memory_gb: null })} options={[['nvlink', 'NVLink: GPUs zusammenfassen'], ['mig', 'MIG: GPU teilen']]} />
            </div>
            {b.mode === 'nvlink' ? (
              <div className="pick-list" style={{ maxHeight: 130 }}>
                {gpus.map((g) => (
                  <label key={g.id}>
                    <input type="checkbox" checked={b.gpu_ids.includes(g.id)} onChange={() => update(i, { gpu_ids: b.gpu_ids.includes(g.id) ? b.gpu_ids.filter((x) => x !== g.id) : [...b.gpu_ids, g.id] })} />
                    <span>
                      {g.name} <span className="sub">{m.gpuLabel(g)}</span>
                    </span>
                  </label>
                ))}
                {gpus.length === 0 && <div className="hint">Lege im Inventar GPUs an.</div>}
              </div>
            ) : (
              <div className="form-grid">
                <Pick label="GPU" value={b.gpu_ids[0] ?? ''} onChange={(v) => update(i, { gpu_ids: v ? [v] : [], profile: null, slices: null, memory_gb: null })} options={[['', '– wählen –'], ...gpus.map((g) => [g.id, `${g.name} (${m.gpuLabel(g)})`])]} />
                {profiles.length > 0 ? (
                  <Pick
                    label="Profil"
                    value={b.profile ?? ''}
                    onChange={(v) => {
                      const p = profiles.find((x) => x.profile === v);
                      update(i, p ? { profile: p.profile, slices: p.slices, memory_gb: p.memory_gb } : { profile: null, slices: null, memory_gb: null });
                    }}
                    options={[['', '– wählen –'], ...profiles.map((p) => [p.profile, `${p.profile} (${p.slices} Slice${p.slices > 1 ? 's' : ''}, ${p.memory_gb} GB)`])]}
                    hint={gpu && used.get(gpu.id) ? `${used.get(gpu.id)} von ${preset.max_slices} Slices der GPU belegt` : undefined}
                  />
                ) : (
                  <>
                    <Text label="Profil" value={b.profile} onChange={(v) => update(i, { profile: v })} />
                    <Text label="Slices" type="number" min={1} value={b.slices} onChange={(v) => update(i, { slices: num(v) })} />
                  </>
                )}
              </div>
            )}
            <button className="btn sm ghost danger" onClick={() => setBundles(bundles.filter((_, j) => j !== i))}>
              <Trash2 size={13} /> Bundle entfernen
            </button>
          </div>
        );
      })}
      <button className="btn sm" onClick={() => setBundles([...bundles, { id: `b${Date.now().toString(36)}`, name: `Bundle ${bundles.length + 1}`, mode: 'nvlink', gpu_ids: [] }])}>
        <Plus size={13} /> GPU-Bundle
      </button>
    </>
  );
}

function KubernetesConfig({ node, m }) {
  const nodes = node.spec?.nodes ?? [];
  const servers = m.placedOf('server');
  const set = (next) => m.setSpec(node.id, { nodes: next });
  return (
    <>
      <div className="hint" style={{ marginBottom: 8 }}>
        Welche Server gehören zum Cluster und welche Rolle haben sie?
      </div>
      {nodes.map((n, i) => (
        <Row key={i} onRemove={() => set(nodes.filter((_, j) => j !== i))}>
          <select value={n.server_id} onChange={(e) => set(nodes.map((x, j) => (j === i ? { ...x, server_id: e.target.value } : x)))} aria-label="Server">
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={n.role} onChange={(e) => set(nodes.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} aria-label="Rolle">
            {m.presets.k8s_roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </Row>
      ))}
      <button className="btn sm" disabled={!servers.length} onClick={() => set([...nodes, { server_id: servers.find((s) => !nodes.some((n) => n.server_id === s.id))?.id ?? servers[0].id, role: 'worker' }])}>
        <Plus size={13} /> Server hinzufügen
      </button>
      {!servers.length && <span className="hint"> Füge zuerst Server in der Ebene Server hinzu.</span>}
    </>
  );
}

function InferenceConfig({ node, m }) {
  const self = node.spec?.hosting !== 'managed';
  const models = (node.models ?? []).filter((x) => x.available).map((x) => x.name);
  const served = m.served[node.id] ?? [];
  const meta = node.spec?.meta ?? {};
  const setMeta = (patch) => m.setSpec(node.id, { meta: { ...meta, ...patch } });
  const target = m.runsOn(node.id);
  const gpus = m.endpoints.filter((e) => e.kind === 'gpu');
  const bundles = m.placedOf('interconnect').flatMap((ic) => (ic.spec?.bundles ?? []).map((b) => ({ ic, b })));
  const value = target ? `${target.to_id}|${target.data?.bundle_id ?? ''}` : '';
  return (
    <>
      <div className="field">
        <span>Modelle dieses Inferenzservers</span>
        <div className="pick-list" style={{ maxHeight: 130 }}>
          {models.map((x) => (
            <label key={x}>
              <input type="checkbox" checked={served.includes(x)} onChange={() => m.setServed(node.id, served.includes(x) ? served.filter((y) => y !== x) : [...served, x])} />
              <span>{x}</span>
            </label>
          ))}
          {models.length === 0 && <div className="hint">Keine Modelle gefunden. Teste im Inventar die Verbindung.</div>}
        </div>
      </div>
      {self ? (
        <>
          <Pick
            label="Läuft auf"
            value={value}
            onChange={(v) => {
              const [id, bundle] = v.split('|');
              m.setRunsOn(node.id, v ? { to_id: id, bundle_id: bundle || null } : null);
            }}
            options={[
              ['', '– keiner GPU zugeordnet –'],
              ...gpus.map((g) => [`${g.id}|`, `GPU: ${g.name} (${m.gpuLabel(g)})`]),
              ...bundles.map(({ ic, b }) => [`${ic.id}|${b.id}`, `Bundle: ${b.name} (${ic.name}, ${b.mode === 'mig' ? `MIG ${b.profile ?? ''}` : `${b.gpu_ids.length}× NVLink`})`]),
            ]}
          />
          <div className="form-grid">
            <Text label="Tensor-Parallelität (optional)" type="number" min={1} value={meta.tensor_parallel} onChange={(v) => setMeta({ tensor_parallel: num(v) })} />
            <Text label="Quantisierung (optional)" value={meta.quantization} onChange={(v) => setMeta({ quantization: v })} placeholder="z. B. fp8, awq" />
            <Text label="Max. Kontextlänge (optional)" type="number" min={1} value={meta.max_model_len} onChange={(v) => setMeta({ max_model_len: num(v) })} />
            <Text label="Version (optional)" value={meta.version} onChange={(v) => setMeta({ version: v })} />
          </div>
          <Text label="Weitere Metadaten (optional)" value={meta.notes} onChange={(v) => setMeta({ notes: v })} />
        </>
      ) : (
        <div className="hint">Managed Service: keine GPU-Zuordnung nötig.</div>
      )}
    </>
  );
}

function GatewayConfig({ node, m }) {
  const rows = m.rows.filter((r) => r.gateway_id === node.id);
  const gatewayModels = [...new Set((node.models ?? []).filter((x) => x.available).map((x) => x.name))];
  const backends = m.placedOf('inference');
  const options = backends.flatMap((b) => (b.models ?? []).filter((x) => x.available).map((x) => [`${b.id}|${x.name}`, `${x.name} — ${b.name}`]));
  const set = (next) => m.setRows(node.id, next);
  const update = (i, patch) => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="hint" style={{ marginBottom: 8 }}>
        Routen: links das Modell, wie es das Gateway anbietet, rechts das Modell des Inferenzservers, an das es weitergeleitet wird.
      </div>
      {rows.map((r, i) => (
        <Row key={i} onRemove={() => set(rows.filter((_, j) => j !== i))}>
          <select value={r.gateway_model} onChange={(e) => update(i, { gateway_model: e.target.value })} aria-label="Modell am Gateway">
            <option value="">Modell am Gateway…</option>
            {[...new Set([...gatewayModels, r.gateway_model].filter(Boolean))].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <span className="sub">→</span>
          <select value={r.backend_id && r.backend_model ? `${r.backend_id}|${r.backend_model}` : ''} onChange={(e) => { const [b, ...rest] = e.target.value.split('|'); update(i, { backend_id: b, backend_model: rest.join('|') }); }} aria-label="Modell am Inferenzserver">
            <option value="">Modell am Inferenzserver…</option>
            {r.backend_id && r.backend_model && !options.some(([k]) => k === `${r.backend_id}|${r.backend_model}`) && <option value={`${r.backend_id}|${r.backend_model}`}>{r.backend_model}</option>}
            {options.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Row>
      ))}
      <button className="btn sm" onClick={() => set([...rows, { gateway_id: node.id, gateway_model: '', backend_id: '', backend_model: '' }])}>
        <Plus size={13} /> Route
      </button>
      {backends.length === 0 && <span className="hint"> Füge zuerst Inferenzserver in der Ebene Inferenz hinzu.</span>}
    </>
  );
}

function IamConfig({ node, m }) {
  const services = node.spec?.services ?? [];
  const others = m.endpoints.filter((e) => m.isPlaced(e.id) && e.id !== node.id);
  return (
    <>
      <div className="field">
        <span>Angebundene Dienste</span>
        <div className="pick-list" style={{ maxHeight: 150 }}>
          {others.map((e) => (
            <label key={e.id}>
              <input type="checkbox" checked={services.includes(e.id)} onChange={() => m.setSpec(node.id, { services: services.includes(e.id) ? services.filter((x) => x !== e.id) : [...services, e.id] })} />
              <span>
                {e.name} <span className="sub">{m.kindLabel(e.kind)}</span>
              </span>
            </label>
          ))}
          {others.length === 0 && <div className="hint">Noch keine Komponenten in der Topologie.</div>}
        </div>
      </div>
      <Check checked={node.spec?.enterprise_accounts} onChange={(v) => m.setSpec(node.id, { enterprise_accounts: v })}>
        Enterprise Accounts verwendet
      </Check>
    </>
  );
}

const BARS = { datacenter: DatacenterConfig, server: ServerConfig, interconnect: InterconnectConfig, kubernetes: KubernetesConfig, llm: InferenceConfig, ai_proxy: GatewayConfig, iam: IamConfig };

export default function ConfigBar({ node, m, onRemove }) {
  const Bar = BARS[node.kind];
  return (
    <div className="topo-config card">
      <div className="cfg-head">
        <strong>{node.name}</strong>
        <span className="sub">{m.kindLabel(node.kind)}</span>
        <span style={{ flex: 1 }} />
        {m.editable && (
          <button className="btn sm ghost danger" onClick={onRemove}>
            Aus Topologie nehmen
          </button>
        )}
      </div>
      <fieldset disabled={!m.editable} className="cfg-body">
        {Bar ? <Bar node={node} m={m} /> : <div className="hint">Für diese Komponentenart gibt es keine weitere Konfiguration. Angaben pflegst du im Inventar.</div>}
      </fieldset>
    </div>
  );
}
