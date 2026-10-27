// Prüfung und Bereinigung der typspezifischen Angaben der Inventar-Komponenten und ihrer Zuordnungen.
import { GATEWAY_PRODUCTS, GPU_TYPES, HOSTING_PROVIDERS, INFERENCE_PROVIDERS, K8S_DISTRIBUTIONS } from './inventory.js';

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
  return { provider, provider_name: str(s.provider_name), hosting: p.hosting, served_models: list(s.served_models) };
}

function gateway(s) {
  const product = s.product ?? 'litellm';
  if (!GATEWAY_PRODUCTS.some((x) => x.key === product)) throw bad('Unbekanntes Gateway-Produkt');
  return { product, product_name: str(s.product_name), instances: Math.max(1, Math.round(num(s.instances) ?? 1)) };
}

// Typspezifische Angaben prüfen; unbekannte Felder fallen weg.
export function cleanSpec(kind, raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  if (kind === 'datacenter') return datacenter(s);
  if (kind === 'kubernetes') return kubernetes(s);
  if (kind === 'gpu') return gpu(s);
  if (kind === 'llm') return inference(s);
  if (kind === 'ai_proxy') return gateway(s);
  return { note: str(s.note, 500) };
}

// Zuordnungen prüfen: erlaubte Arten je Verbindung und vorhandene MIG-Instanzen.
const LINK_RULES = {
  hosted_in: [['gpu', 'kubernetes'], ['datacenter']],
  cluster: [['gpu'], ['kubernetes']],
  runs_on: [['llm'], ['gpu']],
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
    if (!rule[0].includes(from.kind) || !rule[1].includes(to.kind)) throw bad(`Ungültige Zuordnung: ${from.kind} → ${to.kind} (${l.kind})`);
    let slice = null;
    if (l.kind === 'runs_on' && l.data?.mig_slice !== undefined && l.data?.mig_slice !== null) {
      slice = Number(l.data.mig_slice);
      const layout = to.spec?.mig?.layout ?? [];
      if (!to.spec?.mig?.enabled || !Number.isInteger(slice) || slice < 0 || slice >= layout.length) throw bad(`MIG-Instanz an „${to.name}“ existiert nicht`);
    }
    const key = `${l.kind}|${l.from_id}|${l.to_id}|${slice ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: l.kind, from_id: l.from_id, to_id: l.to_id, data: slice === null ? {} : { mig_slice: slice } });
  }
  return out;
}
