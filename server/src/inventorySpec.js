// Prüfung und Bereinigung der typspezifischen Angaben der Inventar-Komponenten und ihrer Zuordnungen.
import { GATEWAY_PRODUCTS, GPU_TYPES, HOSTING_PROVIDERS, INFERENCE_PROVIDERS, INTERCONNECT_TYPES, K8S_DISTRIBUTIONS, K8S_ROLES, SERVER_TYPES } from './inventory.js';

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const str = (v, max = 200) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const list = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 30) : []);
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const tri = (v) => (v === undefined || v === null || v === '' ? null : Boolean(v));

function datacenter(s) {
  const provider = s.provider ?? 'other';
  if (!HOSTING_PROVIDERS.some((p) => p.key === provider)) throw bad('Unbekannter Hosting-Anbieter');
  return {
    provider,
    provider_name: str(s.provider_name),
    on_prem: provider === 'on_prem' || Boolean(s.on_prem),
    region: str(s.region),
    country: str(s.country, 2)?.toUpperCase() ?? null,
    certifications: list(s.certifications),
    renewable_energy: tri(s.renewable_energy),
    pue: num(s.pue),
    // Optional: verfügbare Ressourcen des Rechenzentrums.
    cpu_cores: num(s.cpu_cores),
    ram_gb: num(s.ram_gb),
    storage_tb: num(s.storage_tb),
  };
}

function kubernetes(s) {
  const distribution = s.distribution ?? 'vanilla';
  if (!K8S_DISTRIBUTIONS.some((x) => x.key === distribution)) throw bad('Unbekannte Kubernetes-Distribution');
  return {
    operation: s.operation === 'managed' ? 'managed' : 'self_managed',
    distribution,
    distribution_name: str(s.distribution_name),
    version: str(s.version, 40),
    certifications: list(s.certifications),
    cis_hardened: tri(s.cis_hardened),
    // Knoten des Clusters: Server mit ihrer Rolle.
    nodes: (Array.isArray(s.nodes) ? s.nodes : [])
      .map((n) => ({ server_id: str(n?.server_id), role: n?.role }))
      .filter((n) => n.server_id && K8S_ROLES.some((r) => r.key === n.role)),
  };
}

// GPU: genau eine GPU je Eintrag. MIG teilt sie in Instanzen (layout), denen Inferenzserver einzeln zugeordnet werden.
function gpu(s) {
  const gpuType = s.gpu_type ?? 'h100';
  let memory;
  let maxSlices = 7;
  let custom = null;
  if (gpuType === 'custom') {
    const c = s.custom ?? {};
    if (!str(c.name)) throw bad('Eigener GPU-Typ: Name fehlt');
    memory = num(c.memory_gb);
    if (!memory || memory <= 0) throw bad('Eigener GPU-Typ: Speicher (GB) fehlt');
    maxSlices = Math.min(Math.max(Math.round(num(c.max_mig_slices) ?? 7), 1), 7);
    custom = { name: str(c.name), vendor: str(c.vendor), memory_gb: memory, mig_capable: Boolean(c.mig_capable), max_mig_slices: maxSlices, notes: str(c.notes, 500) };
  } else {
    const g = GPU_TYPES[gpuType];
    if (!g) throw bad('Unbekannter GPU-Typ');
    memory = g.memory_gb;
    maxSlices = g.max_slices;
  }
  let mig = { enabled: false, layout: [] };
  if (s.mig?.enabled) {
    if (gpuType === 'custom' && !custom.mig_capable) throw bad('Dieser GPU-Typ unterstützt kein MIG');
    const layout = (s.mig.layout ?? []).map((l) => ({ profile: str(l.profile, 30), slices: Math.round(Number(l.slices)), memory_gb: num(l.memory_gb) }));
    if (!layout.length) throw bad('MIG: mindestens eine Instanz festlegen');
    if (layout.some((l) => !l.profile || !(l.slices >= 1))) throw bad('MIG: Profil und Slices je Instanz angeben');
    if (layout.reduce((n, l) => n + l.slices, 0) > maxSlices) throw bad(`MIG: höchstens ${maxSlices} Rechen-Slices je GPU`);
    mig = { enabled: true, layout };
  }
  return { gpu_type: gpuType, custom, memory_gb: memory, mig };
}

function inference(s) {
  const provider = s.provider ?? 'vllm';
  const p = INFERENCE_PROVIDERS.find((x) => x.key === provider);
  if (!p) throw bad('Unbekannter Anbieter des Inferenzservers');
  const m = s.meta ?? {};
  return {
    provider,
    provider_name: str(s.provider_name),
    hosting: p.hosting,
    // Direkt erreichbar oder nur intern über ein Gateway (fließt in die Souveränitätsziele ein).
    reachability: s.reachability === 'gateway_only' ? 'gateway_only' : 'direct',
    served_models: list(s.served_models),
    // Optionale Angaben zur Inferenz (nur selbst betrieben).
    meta: { tensor_parallel: num(m.tensor_parallel), quantization: str(m.quantization, 40), max_model_len: num(m.max_model_len), version: str(m.version, 40), notes: str(m.notes, 500) },
  };
}

function gateway(s) {
  const product = s.product ?? 'litellm';
  if (!GATEWAY_PRODUCTS.some((x) => x.key === product)) throw bad('Unbekanntes Gateway-Produkt');
  return { product, product_name: str(s.product_name), instances: Math.max(1, Math.round(num(s.instances) ?? 1)) };
}

function server(s) {
  const type = s.server_type ?? 'cpu';
  if (!SERVER_TYPES.some((t) => t.key === type)) throw bad('Unbekannte Server-Art');
  return { server_type: type, model: str(s.model), cpu_cores: num(s.cpu_cores), ram_gb: num(s.ram_gb), storage_tb: num(s.storage_tb) };
}

// Interconnect: Art und GPU-Bundles. nvlink fasst mehrere GPUs zu einer virtuellen größeren GPU zusammen, mig teilt eine GPU in Teile (Profil, Slices).
function interconnect(s) {
  const type = s.type ?? 'nvlink';
  if (!INTERCONNECT_TYPES.some((t) => t.key === type)) throw bad('Unbekannte Interconnect-Art');
  const seen = new Set();
  const bundles = (Array.isArray(s.bundles) ? s.bundles : []).map((b, i) => {
    const mode = b?.mode === 'mig' ? 'mig' : 'nvlink';
    const id = str(b?.id, 40) ?? `b${i + 1}`;
    if (seen.has(id)) throw bad('Bundle-ID doppelt');
    seen.add(id);
    const name = str(b?.name);
    if (!name) throw bad('Jedes GPU-Bundle braucht einen Namen');
    const gpuIds = list(b?.gpu_ids);
    if (mode === 'nvlink' && gpuIds.length < 2) throw bad(`Bundle „${name}“: NVLink braucht mindestens zwei GPUs`);
    if (mode === 'mig' && gpuIds.length !== 1) throw bad(`Bundle „${name}“: MIG teilt genau eine GPU`);
    const out = { id, name, mode, gpu_ids: gpuIds };
    if (mode === 'mig') {
      out.profile = str(b?.profile, 30);
      out.slices = Math.round(num(b?.slices) ?? 0);
      out.memory_gb = num(b?.memory_gb);
      if (!out.profile || !(out.slices >= 1)) throw bad(`Bundle „${name}“: Profil und Slices angeben`);
    }
    return out;
  });
  return { type, bundles };
}

function iam(s) {
  return { services: list(s.services), enterprise_accounts: Boolean(s.enterprise_accounts) };
}

const MCP_AUTH = ['none', 'bearer', 'oidc'];

// Typspezifische Angaben prüfen; unbekannte Felder fallen weg. Alle Arten kennen eine Notiz und (optional) eine überschriebene Version.
export function cleanSpec(kind, raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const common = { note: str(s.note, 500), version_override: str(s.version_override, 40) };
  if (kind === 'datacenter') return { ...datacenter(s), ...common };
  if (kind === 'kubernetes') return { ...kubernetes(s), ...common };
  if (kind === 'gpu') return { ...gpu(s), ...common };
  if (kind === 'llm') return { ...inference(s), ...common };
  if (kind === 'ai_proxy') return { ...gateway(s), ...common };
  if (kind === 'server') return { ...server(s), ...common };
  if (kind === 'interconnect') return { ...interconnect(s), ...common };
  if (kind === 'iam') return { ...iam(s), ...common };
  if (kind === 'mcp') {
    const type = s.auth?.type ?? 'none';
    if (!MCP_AUTH.includes(type)) throw bad('Authentifizierung: Bearer Token, OIDC oder Keine');
    return { ...common, auth: { type } };
  }
  return common;
}

// Zuordnungen prüfen: erlaubte Arten je Verbindung, vorhandene MIG-Instanzen und GPU-Bundles.
const LINK_RULES = {
  hosted_in: { gpu: ['server', 'datacenter', 'kubernetes'], server: ['datacenter'], kubernetes: ['datacenter'], interconnect: ['datacenter'] },
  cluster: { gpu: ['kubernetes'], server: ['kubernetes'] },
  runs_on: { llm: ['gpu', 'interconnect'] },
};

export function validateLinks(links, byId) {
  const seen = new Set();
  const out = [];
  for (const l of links ?? []) {
    const rule = LINK_RULES[l.kind];
    if (!rule) throw bad(`Unbekannte Zuordnung „${l.kind}“`);
    const from = byId.get(l.from_id);
    const to = byId.get(l.to_id);
    if (!from || !to) throw bad('Zuordnung verweist auf eine Komponente außerhalb der Plattform');
    if (!rule[from.kind]?.includes(to.kind)) throw bad(`Ungültige Zuordnung: ${from.kind} → ${to.kind} (${l.kind})`);
    const data = {};
    if (l.kind === 'runs_on' && to.kind === 'gpu' && l.data?.mig_slice !== undefined && l.data?.mig_slice !== null) {
      const slice = Number(l.data.mig_slice);
      const layout = to.spec?.mig?.layout ?? [];
      if (!to.spec?.mig?.enabled || !Number.isInteger(slice) || slice < 0 || slice >= layout.length) throw bad(`MIG-Instanz an „${to.name}“ existiert nicht`);
      data.mig_slice = slice;
    }
    if (l.kind === 'runs_on' && to.kind === 'interconnect') {
      if (!(to.spec?.bundles ?? []).some((b) => b.id === l.data?.bundle_id)) throw bad(`GPU-Bundle an „${to.name}“ existiert nicht`);
      data.bundle_id = l.data.bundle_id;
    }
    const key = `${l.kind}|${l.from_id}|${l.to_id}|${data.mig_slice ?? ''}|${data.bundle_id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: l.kind, from_id: l.from_id, to_id: l.to_id, data });
  }
  return out;
}

// Verweise innerhalb der typspezifischen Angaben: Cluster-Knoten, GPUs in Bundles, an IAM angebundene Dienste und MIG-Slices je GPU.
export function validateSpecRefs(endpoint, byId) {
  const s = endpoint.spec ?? {};
  if (endpoint.kind === 'kubernetes') {
    for (const n of s.nodes ?? []) if (byId.get(n.server_id)?.kind !== 'server') throw bad(`Cluster „${endpoint.name}“: Knoten ist kein Server der Plattform`);
  }
  if (endpoint.kind === 'iam') {
    for (const id of s.services ?? []) if (!byId.has(id) || id === endpoint.id) throw bad(`IAM „${endpoint.name}“: Dienst gehört nicht zur Plattform`);
  }
  if (endpoint.kind === 'interconnect') {
    const used = new Map();
    for (const b of s.bundles ?? []) {
      for (const id of b.gpu_ids) if (byId.get(id)?.kind !== 'gpu') throw bad(`Bundle „${b.name}“: GPU gehört nicht zur Plattform`);
      if (b.mode === 'mig') {
        const gpu = byId.get(b.gpu_ids[0]);
        const max = gpu.spec?.gpu_type === 'custom' ? gpu.spec.custom?.max_mig_slices ?? 7 : GPU_TYPES[gpu.spec?.gpu_type]?.max_slices ?? 7;
        used.set(gpu.id, (used.get(gpu.id) ?? 0) + b.slices);
        if (used.get(gpu.id) > max) throw bad(`MIG: höchstens ${max} Rechen-Slices je GPU (${gpu.name})`);
      }
    }
  }
}
