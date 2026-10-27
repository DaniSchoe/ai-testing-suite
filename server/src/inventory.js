// Inventar einer Plattform: Komponentenarten mit ihren Voreinstellungen (Anbieter, Zertifikate, GPU-Typen, MIG).
// Die Prüfung der typspezifischen Angaben steht in inventorySpec.js.

export const KINDS = ['datacenter', 'server', 'gpu', 'interconnect', 'kubernetes', 'llm', 'ai_proxy', 'mcp', 'vector_db', 'iam', 'observability'];
// Arten, die über eine URL angesprochen werden (Endpunkt ohne /v1 bzw. Basis-URL).
export const URL_KINDS = ['llm', 'ai_proxy', 'mcp', 'vector_db', 'iam', 'observability'];

// jurisdiction: Rechtsraum des Betreibers (für die Souveränitätseinstufung): self = eigener Betrieb, eu, us, other.
export const HOSTING_PROVIDERS = [
  { key: 'on_prem', label: 'Eigener Betrieb (On-Prem)', jurisdiction: 'self' },
  { key: 'hetzner', label: 'Hetzner', jurisdiction: 'eu' },
  { key: 'ovhcloud', label: 'OVHcloud', jurisdiction: 'eu' },
  { key: 'ionos', label: 'IONOS', jurisdiction: 'eu' },
  { key: 'stackit', label: 'STACKIT', jurisdiction: 'eu' },
  { key: 'telekom', label: 'Open Telekom Cloud', jurisdiction: 'eu' },
  { key: 'scaleway', label: 'Scaleway', jurisdiction: 'eu' },
  { key: 'aws', label: 'AWS', jurisdiction: 'us' },
  { key: 'azure', label: 'Microsoft Azure', jurisdiction: 'us' },
  { key: 'gcp', label: 'Google Cloud', jurisdiction: 'us' },
  { key: 'oracle', label: 'Oracle Cloud', jurisdiction: 'us' },
  { key: 'other', label: 'Anderer Anbieter', jurisdiction: 'other' },
];

export const CERTIFICATIONS = [
  'ISO 27001', 'BSI C5', 'NIST SP 800-53', 'NIST CSF', 'SOC 2', 'ISO 27017', 'ISO 27018', 'SecNumCloud', 'TISAX', 'EUCS', 'FedRAMP', 'HDS',
  'ISO 14001', 'EMAS', 'Blauer Engel (Rechenzentrum)',
];

export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'];

export const K8S_DISTRIBUTIONS = [
  { key: 'vanilla', label: 'Kubernetes (Upstream/kubeadm)', managed: false },
  { key: 'openshift', label: 'Red Hat OpenShift', managed: false },
  { key: 'rke2', label: 'Rancher RKE2', managed: false },
  { key: 'k3s', label: 'k3s', managed: false },
  { key: 'talos', label: 'Talos Linux', managed: false },
  { key: 'tanzu', label: 'VMware Tanzu', managed: false },
  { key: 'ske', label: 'STACKIT Kubernetes Engine', managed: true },
  { key: 'ionos', label: 'IONOS Managed Kubernetes', managed: true },
  { key: 'otc-cce', label: 'Open Telekom Cloud CCE', managed: true },
  { key: 'eks', label: 'Amazon EKS', managed: true },
  { key: 'aks', label: 'Azure AKS', managed: true },
  { key: 'gke', label: 'Google GKE', managed: true },
  { key: 'other', label: 'Andere', managed: null },
];

// MIG: Aufteilung in bis zu sieben Rechen-Slices; Speicher je Profil = Speicher/8 × Faktor (so schneidet NVIDIA bei A100/H100/H200 zu).
const migFromMemory = (memory) => [[1, 1], [2, 2], [3, 4], [4, 4], [7, 8]].map(([slices, f]) => ({ profile: `${slices}g.${Math.round((memory / 8) * f)}gb`, slices, memory_gb: Math.round((memory / 8) * f) }));
const migRtx = (memory) => [[1, 1], [2, 2], [4, 4]].map(([slices, f]) => ({ profile: `${slices}g.${Math.round((memory / 4) * f)}gb`, slices, memory_gb: Math.round((memory / 4) * f) }));

// approximate: Profile für Blackwell-Rechenzentrums-GPUs sind abgeleitet und sollten gegen das Datenblatt geprüft werden.
export const GPU_TYPES = {
  h100: { label: 'NVIDIA H100', memory_gb: 80, max_slices: 7, mig: migFromMemory(80) },
  h200: { label: 'NVIDIA H200', memory_gb: 141, max_slices: 7, mig: migFromMemory(141) },
  'rtx-pro-6000': { label: 'NVIDIA RTX PRO 6000 (Blackwell)', memory_gb: 96, max_slices: 4, mig: migRtx(96) },
  b100: { label: 'NVIDIA B100', memory_gb: 192, max_slices: 7, mig: migFromMemory(192), approximate: true },
  b200: { label: 'NVIDIA B200', memory_gb: 180, max_slices: 7, mig: migFromMemory(180), approximate: true },
  b300: { label: 'NVIDIA B300', memory_gb: 288, max_slices: 7, mig: migFromMemory(288), approximate: true },
};

// jurisdiction: Rechtsraum des Anbieters bei Managed Services; open: Software ist quelloffen.
export const INFERENCE_PROVIDERS = [
  { key: 'vllm', label: 'vLLM', hosting: 'self', open: true },
  { key: 'sglang', label: 'SGLang', hosting: 'self', open: true },
  { key: 'tgi', label: 'Text Generation Inference (TGI)', hosting: 'self', open: true },
  { key: 'nim', label: 'NVIDIA NIM', hosting: 'self', open: false },
  { key: 'trtllm', label: 'TensorRT-LLM / Triton', hosting: 'self', open: true },
  { key: 'ollama', label: 'Ollama', hosting: 'self', open: true },
  { key: 'llamacpp', label: 'llama.cpp', hosting: 'self', open: true },
  { key: 'other-self', label: 'Anderer Server (selbst betrieben)', hosting: 'self', open: null },
  { key: 'openai', label: 'OpenAI (ChatGPT)', hosting: 'managed', jurisdiction: 'us', flavor: 'openai' },
  { key: 'anthropic', label: 'Anthropic (Claude)', hosting: 'managed', jurisdiction: 'us', flavor: 'claude' },
  { key: 'google', label: 'Google (Gemini)', hosting: 'managed', jurisdiction: 'us', flavor: 'openai' },
  { key: 'azure-openai', label: 'Azure OpenAI', hosting: 'managed', jurisdiction: 'us', flavor: 'openai' },
  { key: 'bedrock', label: 'AWS Bedrock', hosting: 'managed', jurisdiction: 'us', flavor: 'openai' },
  { key: 'mistral', label: 'Mistral AI (La Plateforme)', hosting: 'managed', jurisdiction: 'eu', flavor: 'openai' },
  { key: 'stackit-ai', label: 'STACKIT AI Model Serving', hosting: 'managed', jurisdiction: 'eu', flavor: 'openai' },
  { key: 'ionos-ai', label: 'IONOS AI Model Hub', hosting: 'managed', jurisdiction: 'eu', flavor: 'openai' },
  { key: 'other-managed', label: 'Anderer Dienst (Managed)', hosting: 'managed', jurisdiction: 'other', flavor: 'openai' },
];

export const GATEWAY_PRODUCTS = [
  { key: 'litellm', label: 'LiteLLM', open: true },
  { key: 'envoy-ai', label: 'Envoy AI Gateway', open: true },
  { key: 'kong', label: 'Kong AI Gateway', open: true },
  { key: 'portkey', label: 'Portkey', open: true },
  { key: 'tensorzero', label: 'TensorZero', open: true },
  { key: 'apim', label: 'Azure API Management', open: false },
  { key: 'cloudflare', label: 'Cloudflare AI Gateway', open: false },
  { key: 'openrouter', label: 'OpenRouter', open: false },
  { key: 'other', label: 'Anderes Produkt', open: null },
];

// Ebenen der Topologie, von unten nach oben gelesen von oben nach unten. GPUs hängen an Servern und haben keine eigene Ebene.
export const LAYERS = [
  { key: 'datacenter', label: 'Rechenzentrum', kinds: ['datacenter'] },
  { key: 'server', label: 'Server', kinds: ['server'] },
  { key: 'interconnect', label: 'Interconnect', kinds: ['interconnect'], optional: true },
  { key: 'orchestration', label: 'Orchestration', kinds: ['kubernetes'] },
  { key: 'inference', label: 'Inferenz', kinds: ['llm'] },
  { key: 'gateway', label: 'AI Gateway', kinds: ['ai_proxy'] },
  { key: 'mcp', label: 'MCP', kinds: ['mcp'] },
  { key: 'database', label: 'Datenbanken', kinds: ['vector_db'] },
  { key: 'observability', label: 'Observability', kinds: ['observability'] },
  { key: 'iam', label: 'IAM', kinds: ['iam'] },
];

export const SERVER_TYPES = [
  { key: 'cpu', label: 'CPU-Server' },
  { key: 'gpu', label: 'GPU-Server' },
];
export const INTERCONNECT_TYPES = [
  { key: 'nvlink', label: 'NVLink / NVSwitch' },
  { key: 'infiniband', label: 'InfiniBand' },
  { key: 'roce', label: 'RoCE (Ethernet)' },
  { key: 'ethernet', label: 'Ethernet' },
  { key: 'other', label: 'Anderes' },
];
export const K8S_ROLES = [
  { key: 'master', label: 'Master (Control Plane)' },
  { key: 'worker', label: 'Worker' },
  { key: 'etcd', label: 'etcd' },
  { key: 'gpu', label: 'GPU-Worker' },
];

export const presets = () => ({
  layers: LAYERS,
  server_types: SERVER_TYPES,
  interconnect_types: INTERCONNECT_TYPES,
  k8s_roles: K8S_ROLES,
  kinds: KINDS,
  hosting_providers: HOSTING_PROVIDERS,
  certifications: CERTIFICATIONS,
  k8s_distributions: K8S_DISTRIBUTIONS,
  gpu_types: Object.fromEntries(Object.entries(GPU_TYPES).map(([k, g]) => [k, { label: g.label, memory_gb: g.memory_gb, max_slices: g.max_slices, mig: g.mig, approximate: Boolean(g.approximate) }])),
  inference_providers: INFERENCE_PROVIDERS,
  gateway_products: GATEWAY_PRODUCTS,
});
