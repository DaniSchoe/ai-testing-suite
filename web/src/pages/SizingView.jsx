import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend as RLegend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRight, Boxes, Cable, Cpu, Info, Minus, Network, Pencil, Plus, Save, Server, Upload, Users } from 'lucide-react';
import { api, can, Card, fmt, Modal, useApi, useUser } from '../lib.jsx';
import { ASSUME, DTYPES, evaluate, GPUS, gpuOf, KV_DTYPES, loadCurve, MODELS, minGpus, fit as fitModel } from '../platformModel.js';

const SERVERS = { vllm: 'vLLM', sglang: 'SGLang', tgi: 'Text Generation Inference', trtllm: 'TensorRT-LLM' };
const GATEWAYS = { litellm: 'LiteLLM', other: 'Anderes AI-Gateway' };
const COMPONENT_TITLES = { gpu: 'GPUs (DCGM-Exporter)', inference: 'Inferenzserver (vLLM /metrics)', gateway: 'AI-Gateway (LiteLLM /metrics)' };
const COMPONENT_HINT = {
  gpu: 'Prometheus-Endpunkt des NVIDIA DCGM-Exporters, z. B. http://dcgm-exporter.gpu-operator:9400/metrics. Bei mehreren Knoten eine URL je Zeile.',
  inference: 'Metrik-Endpunkt des Inferenzservers, bei vLLM http://<host>:8000/metrics.',
  gateway: 'Prometheus-Endpunkt von LiteLLM (Callback "prometheus" aktivieren), z. B. https://litellm.example.com/metrics.',
};
const COMPONENT_DOCS = 'https://docs.nvidia.com/datacenter/dcgm/latest/reference/dcgm-exporter-metrics.html';

const num = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : fmt.num(v, d));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

// Eigene Modelle aus einer JSON-Datei; im Browser gemerkt.
function useCustomModels() {
  const [models, setModels] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('platform.models') ?? '[]');
    } catch {
      return [];
    }
  });
  const save = (list) => {
    setModels(list);
    try {
      localStorage.setItem('platform.models', JSON.stringify(list));
    } catch {
      /* Speicher nicht verfügbar */
    }
  };
  return [models, save];
}

// JSON mit Modelldaten prüfen: Objekt oder Liste mit name, params_b, layers, kv_heads, head_dim (active_b, kv_bytes_per_token optional).
export function parseModels(text) {
  const raw = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : raw.models ?? [raw];
  return list.map((m, i) => {
    const params_b = Number(m.params_b ?? m.parameters_b);
    const layers = Number(m.layers ?? m.num_hidden_layers);
    const kv_heads = Number(m.kv_heads ?? m.num_key_value_heads);
    const head_dim = Number(m.head_dim ?? (m.hidden_size && m.num_attention_heads ? m.hidden_size / m.num_attention_heads : NaN));
    const kv_bytes_per_token = m.kv_bytes_per_token == null ? undefined : Number(m.kv_bytes_per_token);
    if (!(params_b > 0)) throw new Error(`Eintrag ${i + 1}: params_b (Parameter in Milliarden) fehlt`);
    if (!kv_bytes_per_token && !(layers > 0 && kv_heads > 0 && head_dim > 0)) throw new Error(`Eintrag ${i + 1}: layers, kv_heads und head_dim (oder kv_bytes_per_token) fehlen`);
    return { id: `custom-${String(m.id ?? m.name ?? i).toLowerCase().replace(/\W+/g, '-')}`, name: `${m.name ?? m.id ?? `Modell ${i + 1}`} (eigene Daten)`, params_b, active_b: Number(m.active_b ?? params_b), layers, kv_heads, head_dim, kv_bytes_per_token };
  });
}

export default function SizingView({ platformId }) {
  const base = `/api/platforms/${platformId}/sizing`;
  const user = useUser();
  const admin = can(user, 'endpoints.manage');
  const platform = useApi(base);
  const live = useApi(`${base}/live`, { interval: 10000 });
  const loads = useApi(`${base}/load-results`, { interval: 60000 });
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // 'gpu' | 'inference' | 'gateway'
  const [custom, saveCustom] = useCustomModels();
  const [uploadError, setUploadError] = useState(null);
  const [loadModel, setLoadModel] = useState('');

  useEffect(() => {
    if (platform.data && !cfg) setCfg(platform.data.config);
  }, [platform.data, cfg]);

  const allModels = useMemo(() => [...MODELS, ...custom], [custom]);
  const model = allModels.find((m) => m.id === cfg?.workload.model) ?? MODELS.find((m) => m.id === 'qwen3-32b');
  const result = useMemo(() => (cfg ? evaluate(cfg, model) : null), [cfg, model]);
  const withExtra = useMemo(() => (cfg && cfg.extra.gpu_count > 0 ? evaluate(cfg, model, { withExtra: true }) : null), [cfg, model]);
  const loadList = loads.data ?? [];
  const measured = loadList.find((l) => l.model === loadModel) ?? loadList.find((l) => l.model === model.id) ?? loadList[0];

  if (platform.error) return <div className="error-box">{platform.error}</div>;
  if (!cfg || !result) return null;

  const set = (path, value) => {
    setCfg((c) => {
      const next = structuredClone(c);
      let o = next;
      const keys = path.split('.');
      keys.slice(0, -1).forEach((k) => (o = o[k]));
      o[keys.at(-1)] = value;
      return next;
    });
    setDirty(true);
  };
  const gpu = gpuOf(cfg.cluster.gpu_type, cfg.cluster.custom_gpu);
  const tpOptions = [1, 2, 4, 8, 16, 32].filter((t) => t <= cfg.cluster.gpu_count);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api(base, { method: 'PUT', body: cfg });
      setCfg(saved.config);
      setDirty(false);
      platform.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function upload(file) {
    setUploadError(null);
    try {
      const list = parseModels(await file.text());
      saveCustom([...custom.filter((c) => !list.some((n) => n.id === c.id)), ...list]);
      set('workload.model', list[0].id);
    } catch (e) {
      setUploadError(e.message);
    }
  }

  const liveOf = (c) => live.data?.components?.[c];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sizing</h1>
          <p>Baue deine GPU-Plattform zusammen und sieh, wie viel VRAM und Bandbreite sie hat, welche Modelle laufen, für wie viele Nutzer sie reicht und wie sie sich unter Last verhält.</p>
        </div>
        {admin && (
          <button className="btn primary" onClick={save} disabled={saving || !dirty}>
            <Save size={15} /> {saving ? 'Speichere…' : dirty ? 'Als Ist-Plattform speichern' : 'Gespeichert'}
          </button>
        )}
      </div>
      <div className="error-box" style={{ background: 'var(--primary-soft)', color: 'var(--primary-text)' }}>
        <Info size={14} style={{ verticalAlign: -2 }} /> Alle berechneten Werte sind <strong>Schätzungen</strong> aus Datenblattwerten und einem einfachen Modell (siehe „So wird gerechnet“). Gemessene Werte stammen aus Lasttests und den Metrik-Endpunkten.
        {!admin && ' Änderungen gelten nur in deiner Ansicht; speichern dürfen Administratoren.'}
      </div>
      {error && <div className="error-box">{error}</div>}

      <Card title="Architektur" sub="Anfragen laufen von links nach rechts. Mit dem Stift legst du den Metrik-Endpunkt je Komponente fest.">
        <div className="arch">
          <ArchTile icon={<Users size={18} />} title="Clients" subtitle="Anwendungen und Nutzer">
            <KeyValue rows={[['Nutzer (Ziel)', num(result.users)], ['Anfragen/s', num(result.gateway.needed_rps, 1)]]} />
            <div className="hint">Aus der Auslegung unten</div>
          </ArchTile>
          <ArrowRight className="arch-arrow" size={20} />
          <ArchTile
            icon={<Cable size={18} />}
            title="AI-Gateway"
            subtitle={GATEWAYS[cfg.cluster.gateway.type] ?? cfg.cluster.gateway.type}
            onEdit={admin ? () => setEditing('gateway') : null}
          >
            <Field label="Instanzen">
              <Stepper value={cfg.cluster.gateway.instances} min={1} max={64} onChange={(v) => set('cluster.gateway.instances', v)} />
            </Field>
            <KeyValue rows={[['Kapazität', `${num(result.gateway.capacity_rps)} Req/s`], ['Bedarf', `${num(result.gateway.needed_rps, 1)} Req/s`]]} />
            <Status ok={result.gateway.ok} okText="Reicht aus" badText="Engpass" />
            <LiveValues component="gateway" data={liveOf('gateway')} />
          </ArchTile>
          <ArrowRight className="arch-arrow" size={20} />
          <ArchTile icon={<Server size={18} />} title="Inferenzserver" subtitle={SERVERS[cfg.cluster.inference.server]} onEdit={admin ? () => setEditing('inference') : null}>
            <Field label="Server">
              <select value={cfg.cluster.inference.server} onChange={(e) => set('cluster.inference.server', e.target.value)}>
                {Object.entries(SERVERS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="GPUs je Instanz (TP)">
              <select value={cfg.cluster.inference.tensor_parallel} onChange={(e) => set('cluster.inference.tensor_parallel', Number(e.target.value))}>
                {tpOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <KeyValue rows={[['Instanzen', num(result.replicas)], ['Gleichzeitig (Ziel)', num(result.concurrent)]]} />
            <LiveValues component="inference" data={liveOf('inference')} />
          </ArchTile>
          <ArrowRight className="arch-arrow" size={20} />
          <div className="arch-stack">
            <ArchTile icon={<Cpu size={18} />} title="GPUs" subtitle={`${cfg.cluster.gpu_count} × ${gpu.name}`} onEdit={admin ? () => setEditing('gpu') : null}>
              <Field label="Typ">
                <select value={cfg.cluster.gpu_type} onChange={(e) => set('cluster.gpu_type', e.target.value)}>
                  {Object.entries(GPUS).map(([k, g]) => (
                    <option key={k} value={k}>
                      {g.name}
                    </option>
                  ))}
                  {cfg.cluster.custom_gpu && <option value="custom">{cfg.cluster.custom_gpu.name || 'Eigene GPU'}</option>}
                </select>
              </Field>
              <Field label="Anzahl">
                <Stepper value={cfg.cluster.gpu_count} min={1} max={512} onChange={(v) => set('cluster.gpu_count', v)} />
              </Field>
              <label className="checkbox" title={gpu.nvlink_gbs ? '' : 'Dieser GPU-Typ hat kein NVLink'}>
                <input type="checkbox" checked={cfg.cluster.nvlink && gpu.nvlink_gbs > 0} disabled={!gpu.nvlink_gbs} onChange={(e) => set('cluster.nvlink', e.target.checked)} /> NVLink
                {gpu.nvlink_gbs > 0 && cfg.cluster.nvlink ? ` (${gpu.nvlink_gbs} GB/s)` : ''}
              </label>
              <KeyValue rows={[['VRAM', `${num(result.vram_gb)} GB`], ['Bandbreite', `${num(result.bw_tbs, 1)} TB/s`]]} />
              <LiveValues component="gpu" data={liveOf('gpu')} />
            </ArchTile>
            <ArchTile ghost icon={<Plus size={18} />} title="Erweiterung (Planung)" subtitle="zusätzliche GPUs">
              <Field label="Typ">
                <select value={cfg.extra.gpu_type} onChange={(e) => set('extra.gpu_type', e.target.value)}>
                  {Object.entries(GPUS).map(([k, g]) => (
                    <option key={k} value={k}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Anzahl">
                <Stepper value={Number(cfg.extra.gpu_count)} min={0} max={512} onChange={(v) => set('extra.gpu_count', v)} />
              </Field>
              {withExtra && <div className="hint">Ergebnis siehe „Mit Erweiterung“</div>}
            </ArchTile>
          </div>
        </div>
      </Card>

      <Card title="Annahmen für die Auslegung" sub="Welches Modell läuft, und wie nutzen die Nutzer es?">
        <div className="form-grid">
          <label className="field">
            <span>Modell</span>
            <select value={model.id} onChange={(e) => set('workload.model', e.target.value)}>
              {allModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.params_b} Mrd.
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Eigene Modelldaten (JSON)</span>
            <label className="btn" style={{ justifyContent: 'center' }}>
              <Upload size={14} /> JSON hochladen
              <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
            </label>
            {uploadError ? <div className="hint" style={{ color: 'var(--bad)' }}>{uploadError}</div> : <div className="hint">Liste mit name, params_b, layers, kv_heads, head_dim (optional active_b, kv_bytes_per_token).</div>}
          </label>
          <label className="field">
            <span>Gewichte</span>
            <select value={cfg.workload.dtype} onChange={(e) => set('workload.dtype', e.target.value)}>
              {Object.entries(DTYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>KV-Cache</span>
            <select value={cfg.workload.kv_dtype} onChange={(e) => set('workload.kv_dtype', e.target.value)}>
              {Object.entries(KV_DTYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Ø Kontext je Anfrage (Tokens)" value={cfg.workload.avg_context} min={128} max={1000000} onChange={(v) => set('workload.avg_context', v)} />
          <NumberField label="Ø Ausgabe (Tokens)" value={cfg.workload.avg_output} min={1} max={100000} onChange={(v) => set('workload.avg_output', v)} />
          <NumberField label="Pause zwischen Anfragen eines Nutzers (s)" value={cfg.workload.think_time_s} min={1} max={3600} onChange={(v) => set('workload.think_time_s', v)} />
          <NumberField label="Ziel: Tokens/s je Nutzer" value={cfg.workload.target_tps} min={1} max={500} onChange={(v) => set('workload.target_tps', v)} />
        </div>
      </Card>

      <div className="grid kpis">
        <Kpi title="VRAM gesamt" value={`${num(result.vram_gb)} GB`} sub={`nutzbar je Instanz ${num(result.fit.usable_gb)} GB, Gewichte ${num(result.fit.weights_gb)} GB`} extra={withExtra && `${num(withExtra.vram_gb)} GB`} />
        <Kpi title="Speicherbandbreite" value={`${num(result.bw_tbs, 1)} TB/s`} sub={`${num(result.tflops16)} TFLOPS FP16 · NVLink ${result.nvlink_gbs ? `${result.nvlink_gbs} GB/s` : 'nein'}`} extra={withExtra && `${num(withExtra.bw_tbs, 1)} TB/s`} />
        <Kpi
          title="Ausgelegt für Nutzer"
          value={result.fits ? num(result.users) : '–'}
          sub={result.fits ? `je ≥ ${cfg.workload.target_tps} Tokens/s, Anfrage alle ${cfg.workload.think_time_s} s` : 'Modell passt nicht auf eine Instanz'}
          extra={withExtra && num(withExtra.users)}
          icon={<Users size={16} />}
        />
        <Kpi title="Max. Durchsatz" value={result.fits ? `${num(result.max_tps)} Tokens/s` : '–'} sub={`${num(result.replicas)} Instanz(en), Sättigung durch KV-Cache oder max_num_seqs`} extra={withExtra && `${num(withExtra.max_tps)} Tokens/s`} />
      </div>
      {withExtra && (
        <div className="hint" style={{ marginBottom: 16 }}>
          Die Werte in Blau („Mit Erweiterung“) gelten mit +{cfg.extra.gpu_count} × {GPUS[cfg.extra.gpu_type]?.name}: {withExtra.users - result.users >= 0 ? '+' : ''}
          {num(withExtra.users - result.users)} Nutzer, {num(withExtra.max_tps - result.max_tps)} Tokens/s mehr Durchsatz.
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <LoadBehavior result={result} withExtra={withExtra} measured={measured} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card title="Welche Modelle laufen?" sub={`Auf einer Instanz mit ${cfg.cluster.inference.tensor_parallel} × ${gpu.name} (${num(cfg.cluster.inference.tensor_parallel * gpu.vram_gb)} GB)`} flush>
          <ModelFit cfg={cfg} models={allModels} gpu={gpu} extraGpu={cfg.extra.gpu_count > 0 ? gpuOf(cfg.extra.gpu_type) : null} />
        </Card>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card
          title="Schätzung gegen Messung"
          sub="Letzter Lasttest je Modell gegen die Schätzung bei gleicher Parallelität"
          action={
            loadList.length > 0 && (
              <select className="inline" value={measured?.model ?? ''} onChange={(e) => setLoadModel(e.target.value)} aria-label="Lasttest-Modell">
                {loadList.map((l) => (
                  <option key={l.model} value={l.model}>
                    {l.model}
                  </option>
                ))}
              </select>
            )
          }
        >
          <EstimateVsMeasured measured={measured} result={result} cfg={cfg} />
        </Card>
      </div>

      <details className="card" style={{ marginBottom: 24 }}>
        <summary style={{ padding: 16, cursor: 'pointer', fontWeight: 600 }}>So wird gerechnet (Annahmen und Grenzen)</summary>
        <div className="card-body">
          <ul className="steps">
            <li>VRAM: Gewichte = Parameter × Bytes je Parameter × {ASSUME.weight_overhead}; je GPU {ASSUME.overhead_gb_per_gpu} GB Reserve für CUDA und Aktivierungen. Nutzbar sind GPU-Speicheranteil (Standard 90 %) × VRAM. Der Rest ist KV-Cache.</li>
            <li>KV-Cache je Token = 2 × Layer × KV-Heads × Head-Dimension × Bytes (bei MLA-Modellen ein fester Wert). Aus dem freien Speicher folgt, wie viele Anfragen mit dem Ø Kontext gleichzeitig laufen.</li>
            <li>Decode-Schritt (Roofline): Zeit = max(Speicherzeit, Rechenzeit). Speicherzeit = (gelesene Gewichte + KV-Cache) / (Bandbreite × {ASSUME.mem_efficiency}); bei MoE werden mit wachsendem Batch mehr Experten gelesen. Rechenzeit = 2 × aktive Parameter × Batch / (TFLOPS × {ASSUME.mfu}).</li>
            <li>Tensor-Parallelität skaliert mit {ASSUME.tp_eff_nvlink * 100} % Effizienz mit NVLink und {ASSUME.tp_eff_pcie * 100} % ohne.</li>
            <li>Nutzer: größter Batch, bei dem jeder Nutzer das Ziel-Tempo hält, hochgerechnet über Anfragedauer und Pause zwischen Anfragen. Das Gateway wird mit seinen Req/s je Instanz verglichen (Richtwert, in der Komponente änderbar).</li>
            <li>Nicht enthalten: Prefill-Spitzen, Prefix-Caching, spekulatives Dekodieren, Netzwerk und Scheduler-Overhead. Echte Werte liefern Lasttests mit Metrik-Endpunkten; sie fließen unter „Schätzung gegen Messung“ ein.</li>
          </ul>
        </div>
      </details>

      {editing && (
        <ComponentDialog base={base}
          component={editing}
          cfg={cfg}
          set={set}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ArchTile({ icon, title, subtitle, children, onEdit, ghost }) {
  return (
    <section className={`arch-tile${ghost ? ' ghost' : ''}`}>
      <div className="arch-head">
        <span className="icon-chip">{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div className="sub">{subtitle}</div>
        </div>
        {onEdit && (
          <button className="btn ghost sm" onClick={onEdit} aria-label={`${title} konfigurieren`} title="Metrik-Endpunkt und Details">
            <Pencil size={14} />
          </button>
        )}
      </div>
      <div className="arch-body">{children}</div>
    </section>
  );
}

const Field = ({ label, children }) => (
  <label className="arch-field">
    <span>{label}</span>
    {children}
  </label>
);

function Stepper({ value, onChange, min, max }) {
  return (
    <span className="stepper">
      <button type="button" className="btn sm" onClick={() => onChange(clamp(value - 1, min, max))} disabled={value <= min} aria-label="Weniger">
        <Minus size={12} />
      </button>
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} />
      <button type="button" className="btn sm" onClick={() => onChange(clamp(value + 1, min, max))} disabled={value >= max} aria-label="Mehr">
        <Plus size={12} />
      </button>
    </span>
  );
}

function NumberField({ label, value, onChange, min, max }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} />
    </label>
  );
}

const KeyValue = ({ rows }) => (
  <dl className="kv">
    {rows.map(([k, v]) => (
      <div key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </div>
    ))}
  </dl>
);

const Status = ({ ok, okText, badText }) => <span className={`badge ${ok ? 'passed' : 'failed'}`}>{ok ? `✓ ${okText}` : `✕ ${badText}`}</span>;

// Die wichtigsten Livewerte der Komponente aus dem Metrik-Endpunkt.
function LiveValues({ component, data }) {
  const v = data?.values;
  if (!data) return <div className="hint">Kein Metrik-Endpunkt (Stift)</div>;
  if (!v) return <div className="hint" style={{ color: 'var(--bad)' }}>Metriken nicht lesbar: {data.error}</div>;
  const rows = {
    gpu: [
      ['GPUs erkannt', num(v.gpus)],
      ['Auslastung Ø', v.util_pct == null ? '–' : `${num(v.util_pct)} %`],
      ['VRAM belegt', v.mem_used_mib == null ? '–' : `${num(v.mem_used_mib / 1024)} GB`],
      ['Leistung', v.power_w == null ? '–' : `${num(v.power_w)} W`],
      ['Temperatur max', v.temp_c_max == null ? '–' : `${num(v.temp_c_max)} °C`],
      ['Speicher aktiv', v.dram_active == null ? '–' : `${num(v.dram_active * 100)} %`],
    ],
    inference: [
      ['Laufende Anfragen', num(v.running)],
      ['Wartend', num(v.waiting)],
      ['KV-Cache belegt', v.kv_cache == null ? '–' : `${num(v.kv_cache * 100)} %`],
      ['Verdrängungen', num(v.preemptions_total)],
    ],
    gateway: [
      ['In Bearbeitung', num(v.in_flight)],
      ['Anfragen gesamt', num(v.requests_total)],
      ['Fehlgeschlagen', num(v.failed_total)],
    ],
  }[component];
  return (
    <div className="arch-live">
      <div className="hint">Live</div>
      <KeyValue rows={rows.filter(([, val]) => val !== '–')} />
    </div>
  );
}

function Kpi({ title, value, sub, extra, icon }) {
  return (
    <section className="card kpi">
      <div className="kpi-top">
        <span>{title}</span>
        {icon && <span className="kpi-icon">{icon}</span>}
      </div>
      <div className="kpi-value">{value}</div>
      {extra && <div style={{ color: 'var(--primary-text)', fontWeight: 600, fontSize: 13 }}>Mit Erweiterung: {extra}</div>}
      <div className="kpi-sub">{sub}</div>
    </section>
  );
}

// Verhalten unter Last: gleichzeitige Anfragen gegen Tempo je Nutzer und Gesamtdurchsatz; gemessene Lasttest-Stufen als Punkte.
function LoadBehavior({ result, withExtra, measured }) {
  const stages = (measured?.stages ?? []).filter((s) => s.tokens_per_s != null);
  const maxX = Math.max(256, result.concurrent * 3, ...stages.map((s) => s.concurrency * 2));
  const rows = useMemo(() => {
    const base = loadCurve(result, maxX);
    const extra = withExtra ? loadCurve(withExtra, maxX) : [];
    const xs = new Set([...base.map((p) => p.x), ...stages.map((s) => s.concurrency)]);
    return [...xs]
      .sort((a, b) => a - b)
      .map((x) => {
        const b = result.at(x);
        const row = { x, per_user: b.per_user_tps, total: b.total_tps };
        if (withExtra) {
          const e = withExtra.at(x);
          row.total_extra = e.total_tps;
          row.per_user_extra = e.per_user_tps;
        }
        const m = stages.find((s) => s.concurrency === x);
        if (m) row.measured = m.tokens_per_s;
        return row;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, withExtra, measured]);

  return (
    <Card title="Verhalten unter Last" sub="Geschätzt: Gesamtdurchsatz und Tempo je Nutzer bei steigender Zahl gleichzeitiger Anfragen. Jenseits der Sättigung stauen sich Anfragen.">
      {!result.fits ? (
        <div className="empty">Das Modell passt in dieser Konfiguration nicht auf eine Instanz.</div>
      ) : (
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 18 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="x" type="number" scale="log" domain={[1, 'dataMax']} ticks={rows.map((r) => r.x)} stroke="var(--axis)" fontSize={12} label={{ value: 'Gleichzeitige Anfragen', position: 'insideBottom', offset: -10, fill: 'var(--axis)', fontSize: 12 }} />
              <YAxis yAxisId="total" stroke="var(--axis)" fontSize={12} width={56} tickFormatter={(v) => fmt.num(v, 0)} />
              <YAxis yAxisId="user" orientation="right" stroke="var(--axis)" fontSize={12} width={48} tickFormatter={(v) => fmt.num(v, 0)} />
              <Tooltip formatter={(v, name) => [`${fmt.num(v, 1)} Tokens/s`, name]} labelFormatter={(x) => `${x} gleichzeitige Anfragen`} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }} />
              <RLegend />
              <Line yAxisId="total" dataKey="total" name="Durchsatz gesamt (Schätzung)" stroke="var(--series-1)" strokeWidth={2} dot={false} />
              <Line yAxisId="user" dataKey="per_user" name="Tempo je Nutzer (Schätzung)" stroke="var(--series-2)" strokeWidth={2} dot={false} />
              {withExtra && <Line yAxisId="total" dataKey="total_extra" name="Durchsatz mit Erweiterung" stroke="var(--series-1)" strokeDasharray="5 4" strokeWidth={2} dot={false} />}
              {withExtra && <Line yAxisId="user" dataKey="per_user_extra" name="Tempo je Nutzer mit Erweiterung" stroke="var(--series-2)" strokeDasharray="5 4" strokeWidth={2} dot={false} />}
              {stages.length > 0 && <Line yAxisId="total" dataKey="measured" name="Durchsatz gemessen (Lasttest)" stroke="var(--series-4)" strokeWidth={0} dot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

const STATUS = { ok: ['passed', 'läuft'], tight: ['warn', 'knapp'], no: ['failed', 'passt nicht'] };

function ModelFit({ cfg, models, gpu, extraGpu }) {
  const tp = cfg.cluster.inference.tensor_parallel;
  const util = cfg.cluster.inference.gpu_memory_utilization;
  const { avg_context: ctx, kv_dtype: kv } = cfg.workload;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Modell</th>
            {Object.values(DTYPES).map((d) => (
              <th key={d.label}>{d.label}</th>
            ))}
            <th className="num">Mindestens (FP8)</th>
            <th className="num">Max. Kontext (FP8)</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const min8 = minGpus(m, 'fp8', kv, gpu, cfg.cluster.gpu_count, util, ctx);
            const f8 = fitModel(m, 'fp8', kv, gpu, tp, util, ctx);
            return (
              <tr key={m.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div className="sub">
                    {m.params_b} Mrd.{m.active_b < m.params_b ? `, aktiv ${m.active_b} Mrd.` : ''}
                  </div>
                </td>
                {Object.keys(DTYPES).map((d) => {
                  const f = fitModel(m, d, kv, gpu, tp, util, ctx);
                  const [cls, text] = STATUS[f.status];
                  return (
                    <td key={d}>
                      <span className={`badge ${cls}`}>{text}</span>
                      <div className="sub">{num(f.weights_gb)} GB</div>
                    </td>
                  );
                })}
                <td className="num">{min8 ? `${min8} × ${gpu.name.replace('NVIDIA ', '')}` : `mehr als ${cfg.cluster.gpu_count}`}</td>
                <td className="num">{f8.kv_tokens ? `${num(f8.kv_tokens / 1000)} k Tokens` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {extraGpu && <div className="hint" style={{ padding: 12 }}>Mit den zusätzlichen GPUs (anderer Typ: {extraGpu.name}) gilt dieselbe Gruppengröße, siehe Auslegung oben.</div>}
    </div>
  );
}

function EstimateVsMeasured({ measured, result, cfg }) {
  if (!measured) {
    return <div className="empty">Noch kein Lasttest vorhanden. Führe einen Lasttest für dein Modell aus; mit Metrik-Endpunkten werden GPU, vLLM und LiteLLM dabei mitgemessen.</div>;
  }
  const stages = measured.stages ?? [];
  const p = measured.platform;
  const peak = Math.max(...stages.map((s) => s.tokens_per_s ?? 0), 0);
  const est = result.at(stages.at(-1)?.concurrency ?? 1).total_tps;
  return (
    <>
      <div className="sub" style={{ marginBottom: 10 }}>
        Lasttest vom {fmt.date(measured.finished_at)} über {measured.endpoint_name}. Die Schätzung gilt für das oben gewählte Modell ({cfg.workload.model}) und seine Annahmen; die Messung für {measured.model}.
      </div>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th className="num">Parallel</th>
              <th className="num">Gemessen (Tokens/s)</th>
              <th className="num">Geschätzt (Tokens/s)</th>
              <th className="num">Abweichung</th>
              <th className="num">Antwortzeit p95 (gemessen)</th>
              <th className="num">Fehlerquote</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => {
              const e = result.at(s.concurrency).total_tps;
              const delta = e && s.tokens_per_s != null ? (s.tokens_per_s - e) / e : null;
              return (
                <tr key={s.stage}>
                  <td className="num">{s.concurrency}</td>
                  <td className="num">{num(s.tokens_per_s, 1)}</td>
                  <td className="num">{result.fits ? num(e, 1) : '–'}</td>
                  <td className="num">{delta == null ? '–' : `${delta >= 0 ? '+' : ''}${num(delta * 100)} %`}</td>
                  <td className="num">{fmt.ms(s.latency_ms_p95)}</td>
                  <td className="num">{fmt.pct(s.error_rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        Spitze gemessen {num(peak)} Tokens/s gegen {result.fits ? num(est) : '–'} geschätzt bei der höchsten Stufe. Die Messung enthält den Mix aus leichten und schweren Prompts des Lasttests, die Schätzung nur die oben eingestellten Mittelwerte.
      </div>
      {p ? (
        <KeyValue
          rows={[
            ['GPU-Auslastung (Spitze)', p.gpu?.util_pct_peak == null ? '–' : `${num(p.gpu.util_pct_peak)} %`],
            ['VRAM belegt (Spitze)', p.gpu?.mem_used_mib_peak == null ? '–' : `${num(p.gpu.mem_used_mib_peak / 1024)} GB`],
            ['Leistung (Spitze)', p.gpu?.power_w_peak == null ? '–' : `${num(p.gpu.power_w_peak)} W`],
            ['Laufende Anfragen im Server (Spitze)', num(p.inference?.running_peak)],
            ['Wartende Anfragen (Spitze)', num(p.inference?.waiting_peak)],
            ['KV-Cache belegt (Spitze)', p.inference?.kv_cache_peak == null ? '–' : `${num(p.inference.kv_cache_peak * 100)} %`],
            ['Token-Rate laut vLLM', p.inference?.tokens_per_s == null ? '–' : `${num(p.inference.tokens_per_s)} Tokens/s`],
            ['Anfragen/s laut Gateway', p.gateway?.requests_per_s == null ? '–' : num(p.gateway.requests_per_s, 1)],
          ].filter(([, v]) => v !== '–')}
        />
      ) : (
        <div className="hint">Dieser Lasttest lief ohne Metrik-Endpunkte. Lege sie über den Stift an den Komponenten fest, dann werden GPU-, vLLM- und LiteLLM-Werte mitgemessen.</div>
      )}
    </>
  );
}

// Konfiguration einer Komponente: Metrik-Endpunkt (URLs, Key), Test der Verbindung und komponentenspezifische Details.
function ComponentDialog({ base, component, cfg, set, onClose }) {
  const keys = useApi('/api/api-keys');
  const m = cfg.metrics[component];
  const [urls, setUrls] = useState((m.urls ?? []).join('\n'));
  const [keyId, setKeyId] = useState(m.api_key_id ?? '');
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    try {
      setProbe(await api(`${base}/metrics-test`, { method: 'POST', body: { component, urls: urls.split('\n'), api_key_id: keyId || null } }));
    } catch (e) {
      setProbe({ values: null, error: e.message });
    } finally {
      setBusy(false);
    }
  }
  function apply() {
    set(`metrics.${component}`, { urls: urls.split('\n').map((u) => u.trim()).filter(Boolean), api_key_id: keyId || null });
    onClose();
  }
  const cg = cfg.cluster.custom_gpu ?? { name: '', vram_gb: 24, bw_gbs: 600, tflops16: 100, tflops8: 0, nvlink_gbs: 0 };

  return (
    <Modal
      title={COMPONENT_TITLES[component]}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={apply}>
            Übernehmen
          </button>
        </>
      }
    >
      <label className="field">
        <span>Metrik-Endpunkt(e)</span>
        <textarea className="mono" rows={3} value={urls} placeholder="https://…/metrics" onChange={(e) => setUrls(e.target.value)} />
        <div className="hint">
          {COMPONENT_HINT[component]} {component === 'gpu' && <a href={COMPONENT_DOCS} target="_blank" rel="noreferrer">Liste der DCGM-Metriken</a>}
        </div>
      </label>
      <label className="field">
        <span>API-Key für den Endpunkt (optional)</span>
        <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
          <option value="">– keiner –</option>
          {(keys.data ?? []).map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </label>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={test} disabled={busy || !urls.trim()}>
          <Network size={14} /> {busy ? 'Teste…' : 'Verbindung testen'}
        </button>
      </div>
      {probe && (probe.values ? (
        <div className="hint" style={{ marginBottom: 12 }}>
          ✓ {probe.samples} Messwerte gelesen: {Object.entries(probe.values).filter(([, v]) => v != null).map(([k]) => k).join(', ') || 'keine bekannten Metriken'}
        </div>
      ) : (
        <div className="error-box">{probe.error}</div>
      ))}
      <div className="hint" style={{ marginBottom: 12 }}>Die Anwendung ruft den Endpunkt aus ihrem Pod ab (alle 10 s für die Kacheln, alle 5 s während eines Lasttests).</div>
      {component === 'gpu' && (
        <>
          <h3 style={{ fontSize: 14 }}>Eigener GPU-Typ</h3>
          <div className="form-grid">
            {[['name', 'Name'], ['vram_gb', 'VRAM (GB)'], ['bw_gbs', 'Bandbreite (GB/s)'], ['tflops16', 'TFLOPS FP16'], ['tflops8', 'TFLOPS FP8 (0 = keine)'], ['nvlink_gbs', 'NVLink (GB/s, 0 = keins)']].map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input type={k === 'name' ? 'text' : 'number'} value={cg[k]} onChange={(e) => set('cluster.custom_gpu', { ...cg, [k]: k === 'name' ? e.target.value : Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <button className="btn sm" onClick={() => set('cluster.gpu_type', 'custom')} disabled={!cfg.cluster.custom_gpu}>
            Eigene GPU verwenden
          </button>
        </>
      )}
      {component === 'inference' && (
        <div className="form-grid">
          <NumberField label="GPU-Speicheranteil (0,3 bis 0,99)" value={cfg.cluster.inference.gpu_memory_utilization} min={0.3} max={0.99} onChange={(v) => set('cluster.inference.gpu_memory_utilization', v)} />
          <NumberField label="max_num_seqs (gleichzeitige Sequenzen)" value={cfg.cluster.inference.max_num_seqs} min={1} max={8192} onChange={(v) => set('cluster.inference.max_num_seqs', v)} />
        </div>
      )}
      {component === 'gateway' && (
        <div className="form-grid">
          <label className="field">
            <span>Gateway</span>
            <select value={cfg.cluster.gateway.type} onChange={(e) => set('cluster.gateway.type', e.target.value)}>
              {Object.entries(GATEWAYS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Req/s je Instanz (Richtwert)" value={cfg.cluster.gateway.rps_per_instance} min={1} max={100000} onChange={(v) => set('cluster.gateway.rps_per_instance', v)} />
        </div>
      )}
    </Modal>
  );
}
