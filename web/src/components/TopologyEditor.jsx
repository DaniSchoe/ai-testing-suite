// Topologie in festen Ebenen (Rechenzentrum bis IAM). Jede Ebene ist einklappbar und nimmt Komponenten aus dem Inventar auf ("+").
// Ein Klick auf eine Komponente öffnet unter der Ebene ihre Konfigurationsleiste. Verbindungen werden gestrichelt gezeichnet;
// verbundene Komponenten stehen in benachbarten Ebenen untereinander (siehe topologyLayout.js).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Save, X } from 'lucide-react';
import { api, Card, ErrorBox, KIND_META, Loading, Modal, useAction, useApi } from '../lib.jsx';
import ConfigBar from './TopologyConfig.jsx';
import { assignColumns } from './topologyLayout.js';

const COL_W = 196;
const COL_GAP = 16;
const OPTIONAL = ['mcp', 'database', 'observability', 'iam'];

const hasPlaced = (layout) => layout && typeof layout.placed === 'object' && layout.placed !== null;

// Startzustand: gespeicherte Platzierung. Neue Komponenten erscheinen nie von selbst, jede wird manuell hinzugefügt.
function initialPlaced(platform, layers) {
  const out = Object.fromEntries(layers.map((l) => [l.key, []]));
  const known = new Set(platform.endpoints.map((e) => e.id));
  if (hasPlaced(platform.layout)) {
    for (const l of layers) out[l.key] = (platform.layout.placed[l.key] ?? []).filter((id) => known.has(id));
  }
  return out;
}

function initialRows(platform) {
  return platform.routes.flatMap((r) => {
    const maps = r.mappings?.length ? r.mappings : (r.models ?? []).map((x) => ({ gateway_model: x, backend_model: x }));
    return maps.map((x) => ({ gateway_id: r.gateway_endpoint_id, gateway_model: x.gateway_model, backend_id: r.backend_endpoint_id, backend_model: x.backend_model }));
  });
}

export default function TopologyEditor({ platform, editable, onSaved }) {
  const presets = useApi('/api/inventory/presets');
  return <Loading state={presets}>{(p) => <Editor platform={platform} editable={editable} onSaved={onSaved} presets={p} />}</Loading>;
}

function Editor({ platform, editable, onSaved, presets }) {
  const layers = presets.layers;
  const [placed, setPlaced] = useState(() => initialPlaced(platform, layers));
  const [collapsed, setCollapsed] = useState(() => ({ ...(hasPlaced(platform.layout) ? platform.layout.collapsed : {}) }));
  const [specs, setSpecs] = useState(() => Object.fromEntries(platform.endpoints.map((e) => [e.id, e.spec ?? {}])));
  const [links, setLinks] = useState(() => platform.links.map((l) => ({ kind: l.kind, from_id: l.from_id, to_id: l.to_id, data: l.data ?? {} })));
  const [rows, setRowsState] = useState(() => initialRows(platform));
  const [served, setServedState] = useState(() => Object.fromEntries(platform.endpoints.filter((e) => e.kind === 'llm').map((e) => [e.id, e.spec?.served_models ?? []])));
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(null);
  const [showLines, setShowLines] = useState(true);
  const [warnings, setWarnings] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [run, error, busy] = useAction();
  const touch = () => setDirty(true);

  const endpoints = useMemo(() => platform.endpoints.map((e) => ({ ...e, spec: specs[e.id] ?? e.spec ?? {} })), [platform, specs]);
  const byId = useMemo(() => new Map(endpoints.map((e) => [e.id, e])), [endpoints]);
  const isPlaced = (id) => Object.values(placed).some((ids) => ids.includes(id));
  const placedOf = (layerKey) => (placed[layerKey] ?? []).map((id) => byId.get(id)).filter(Boolean);

  // --- Modell: Zuordnungen als Verbindungen ---
  const hostOf = (gpuId) => links.find((l) => l.kind === 'hosted_in' && l.from_id === gpuId && byId.get(l.to_id)?.kind === 'server')?.to_id ?? null;
  const gpusOf = (serverId) => links.filter((l) => l.kind === 'hosted_in' && l.to_id === serverId && byId.get(l.from_id)?.kind === 'gpu').map((l) => byId.get(l.from_id));
  const datacenterOf = (serverId) => links.find((l) => l.kind === 'hosted_in' && l.from_id === serverId && byId.get(l.to_id)?.kind === 'datacenter')?.to_id ?? null;
  const runsOn = (llmId) => links.find((l) => l.kind === 'runs_on' && l.from_id === llmId) ?? null;

  const model = {
    presets,
    editable,
    endpoints,
    served,
    rows,
    placedOf,
    isPlaced,
    hostOf,
    gpusOf,
    datacenterOf,
    runsOn,
    kindLabel: (k) => KIND_META[k]?.label ?? k,
    gpuLabel: (g) => {
      const s = g.spec ?? {};
      const t = presets.gpu_types[s.gpu_type];
      return [s.gpu_type === 'custom' ? s.custom?.name : t?.label, `${s.memory_gb ?? t?.memory_gb ?? '?'} GB`].filter(Boolean).join(', ');
    },
    setSpec: (id, patch) => (setSpecs((s) => ({ ...s, [id]: { ...(s[id] ?? {}), ...patch } })), touch()),
    setDatacenter: (serverId, dcId) => {
      setLinks((ls) => [...ls.filter((l) => !(l.kind === 'hosted_in' && l.from_id === serverId && byId.get(l.to_id)?.kind === 'datacenter')), ...(dcId ? [{ kind: 'hosted_in', from_id: serverId, to_id: dcId, data: {} }] : [])]);
      touch();
    },
    addGpu: (serverId, gpuId) => {
      setLinks((ls) => [...ls.filter((l) => !(l.kind === 'hosted_in' && l.from_id === gpuId)), { kind: 'hosted_in', from_id: gpuId, to_id: serverId, data: {} }]);
      touch();
    },
    removeGpu: (gpuId) => {
      setLinks((ls) => ls.filter((l) => !(l.kind === 'hosted_in' && l.from_id === gpuId) && !(l.kind === 'runs_on' && l.to_id === gpuId)));
      setSpecs((s) =>
        Object.fromEntries(Object.entries(s).map(([id, sp]) => [id, byId.get(id)?.kind === 'interconnect' ? { ...sp, bundles: (sp.bundles ?? []).map((b) => ({ ...b, gpu_ids: b.gpu_ids.filter((x) => x !== gpuId) })).filter((b) => b.gpu_ids.length) } : sp])),
      );
      touch();
    },
    setRunsOn: (llmId, target) => {
      setLinks((ls) => [...ls.filter((l) => !(l.kind === 'runs_on' && l.from_id === llmId)), ...(target ? [{ kind: 'runs_on', from_id: llmId, to_id: target.to_id, data: target.bundle_id ? { bundle_id: target.bundle_id } : {} }] : [])]);
      touch();
    },
    setServed: (id, models) => (setServedState((s) => ({ ...s, [id]: models })), touch()),
    setRows: (gatewayId, next) => (setRowsState((rs) => [...rs.filter((r) => r.gateway_id !== gatewayId), ...next]), touch()),
  };

  function removeNode(id) {
    setPlaced((p) => Object.fromEntries(Object.entries(p).map(([k, ids]) => [k, ids.filter((x) => x !== id)])));
    setLinks((ls) => ls.filter((l) => l.from_id !== id && l.to_id !== id));
    setRowsState((rs) => rs.filter((r) => r.gateway_id !== id && r.backend_id !== id));
    setSpecs((s) =>
      Object.fromEntries(
        Object.entries(s).map(([k, sp]) => {
          if (byId.get(k)?.kind === 'kubernetes') return [k, { ...sp, nodes: (sp.nodes ?? []).filter((n) => n.server_id !== id) }];
          if (byId.get(k)?.kind === 'iam') return [k, { ...sp, services: (sp.services ?? []).filter((x) => x !== id) }];
          return [k, sp];
        }),
      ),
    );
    setSelected(null);
    touch();
  }

  function addNode(layerKey, id) {
    setPlaced((p) => ({ ...p, [layerKey]: [...(p[layerKey] ?? []), id] }));
    setCollapsed((c) => ({ ...c, [layerKey]: false }));
    setAdding(null);
    touch();
  }

  // --- Verbindungen für die Darstellung: [Elternteil in früherer Ebene, Kind] ---
  const edges = useMemo(() => {
    const out = [];
    const host = (gpuId) => links.find((l) => l.kind === 'hosted_in' && l.from_id === gpuId && byId.get(l.to_id)?.kind === 'server')?.to_id;
    for (const l of links) {
      const from = byId.get(l.from_id);
      const to = byId.get(l.to_id);
      if (l.kind === 'hosted_in' && from?.kind === 'server' && to?.kind === 'datacenter') out.push([to.id, from.id]);
      if (l.kind === 'runs_on' && from?.kind === 'llm') {
        if (to?.kind === 'interconnect') out.push([to.id, from.id]);
        else if (to?.kind === 'gpu' && host(to.id)) out.push([host(to.id), from.id]);
      }
    }
    for (const e of endpoints) {
      if (e.kind === 'kubernetes') for (const n of e.spec?.nodes ?? []) out.push([n.server_id, e.id]);
      if (e.kind === 'interconnect') for (const b of e.spec?.bundles ?? []) for (const g of b.gpu_ids) if (host(g)) out.push([host(g), e.id]);
      if (e.kind === 'iam') for (const s of e.spec?.services ?? []) out.push([s, e.id]);
    }
    for (const r of rows) if (r.backend_id) out.push([r.backend_id, r.gateway_id]);
    const order = new Map(layers.flatMap((l, i) => (placed[l.key] ?? []).map((id) => [id, i])));
    const seen = new Set();
    return out.filter(([a, b]) => {
      const key = `${a}|${b}`;
      if (seen.has(key) || !order.has(a) || !order.has(b) || order.get(a) >= order.get(b)) return false;
      seen.add(key);
      return true;
    });
  }, [links, rows, endpoints, byId, placed, layers]);

  const columns = useMemo(() => assignColumns(layers.map((l) => placed[l.key] ?? []), edges), [layers, placed, edges]);
  const colCount = Math.max(1, ...[...columns.values()].map((c) => c + 1));

  // --- Linien aus den gemessenen Positionen der Karten ---
  const frame = useRef(null);
  const cards = useRef({});
  const [paths, setPaths] = useState([]);
  const measure = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const next = edges
      .map(([a, b]) => {
        const ea = cards.current[a]?.getBoundingClientRect();
        const eb = cards.current[b]?.getBoundingClientRect();
        if (!ea || !eb) return null;
        // Die Linie verbindet die untere Kante des oberen mit der oberen Kante des unteren Elements.
        const [top, bottom] = ea.top <= eb.top ? [ea, eb] : [eb, ea];
        const x1 = top.left + top.width / 2 - box.left;
        const y1 = top.bottom - box.top;
        const x2 = bottom.left + bottom.width / 2 - box.left;
        const y2 = bottom.top - box.top;
        const dy = Math.max(24, (y2 - y1) / 2);
        return { key: `${a}|${b}`, d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}` };
      })
      .filter(Boolean);
    setPaths((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
  }, [edges]);
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    if (frame.current) ro.observe(frame.current);
    return () => (window.removeEventListener('resize', measure), ro.disconnect());
  }, [measure]);

  function save() {
    return run(async () => {
      const groups = new Map();
      for (const r of rows.filter((x) => x.gateway_id && x.backend_id && x.gateway_model && x.backend_model)) {
        const key = `${r.gateway_id}|${r.backend_id}`;
        groups.set(key, [...(groups.get(key) ?? []), { gateway_model: r.gateway_model, backend_model: r.backend_model }]);
      }
      const routes = [...groups].map(([key, mappings]) => {
        const [gateway_endpoint_id, backend_endpoint_id] = key.split('|');
        return { gateway_endpoint_id, backend_endpoint_id, mappings };
      });
      const sendKinds = ['datacenter', 'server', 'interconnect', 'kubernetes', 'iam', 'llm'];
      const body = {
        links,
        routes,
        layout: { placed, collapsed },
        specs: Object.fromEntries(endpoints.filter((e) => sendKinds.includes(e.kind)).map((e) => [e.id, specs[e.id] ?? e.spec])),
        served_models: served,
      };
      const res = await api(`/api/platforms/${platform.id}/topology`, { method: 'PUT', body });
      setWarnings(res.warnings ?? []);
      setDirty(false);
      onSaved();
    });
  }

  const candidates = (layer) => endpoints.filter((e) => layer.kinds.includes(e.kind) && !isPlaced(e.id));
  const selNode = selected ? byId.get(selected) : null;
  const optionalCount = OPTIONAL.reduce((n, k) => n + (placed[k] ?? []).length, 0);
  const [optionalOpen, setOptionalOpen] = useState(optionalCount > 0);
  // Oben das AI Gateway, unten das Rechenzentrum. Optionale Komponenten stehen in einem eigenen, aufklappbaren Bereich darunter.
  const mainLayers = layers.filter((l) => !OPTIONAL.includes(l.key)).reverse();
  const optionalLayers = layers.filter((l) => OPTIONAL.includes(l.key));

  const renderLayer = (layer) => {
    const nodes = placedOf(layer.key);
    const closed = Boolean(collapsed[layer.key]);
    const meta = KIND_META[layer.kinds[0]];
    return (
      <section key={layer.key} className="topo-layer">
        <header>
          <button className="btn sm ghost" onClick={() => setCollapsed((c) => ({ ...c, [layer.key]: !closed }))} aria-expanded={!closed} aria-label={`${layer.label} ${closed ? 'ausklappen' : 'einklappen'}`}>
            {closed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          {meta && <meta.Icon size={15} style={{ color: meta.color }} />}
          <strong>{layer.label}</strong>
          {layer.optional && <span className="tag">optional</span>}
          <span className="sub">{nodes.length ? `${nodes.length} Komponente${nodes.length > 1 ? 'n' : ''}` : ''}</span>
          <span style={{ flex: 1 }} />
          {editable && (
            <button className="btn sm" onClick={() => setAdding(layer)} aria-label={`${layer.label}: Komponente hinzufügen`}>
              <Plus size={14} />
            </button>
          )}
        </header>
        {!closed && (
          <>
            <div className="topo-row" style={{ gridTemplateColumns: `repeat(${colCount}, ${COL_W}px)` }}>
              {nodes.map((n) => (
                <div
                  key={n.id}
                  ref={(el) => (el ? (cards.current[n.id] = el) : delete cards.current[n.id])}
                  role="button"
                  tabIndex={0}
                  className={`topo-card${selected === n.id ? ' selected' : ''}`}
                  style={{ gridColumn: (columns.get(n.id) ?? 0) + 1 }}
                  onClick={() => setSelected(n.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(n.id))}
                >
                  <span className="topo-card-title">{n.name}</span>
                  <span className="sub">{summaryOf(n, model, served)}</span>
                  {n.kind === 'server' && gpusOf(n.id).length > 0 && (
                    <span className="topo-gpus">
                      {gpusOf(n.id).map((g) => (
                        <span key={g.id} className="tag" title={model.gpuLabel(g)}>
                          {g.name}
                        </span>
                      ))}
                    </span>
                  )}
                  {n.kind === 'interconnect' && (n.spec?.bundles ?? []).length > 0 && (
                    <span className="topo-gpus">
                      {n.spec.bundles.map((b) => (
                        <span key={b.id} className="tag">
                          {b.name}
                        </span>
                      ))}
                    </span>
                  )}
                  {editable && (
                    <button className="topo-x" aria-label={`${n.name} entfernen`} title="Aus der Topologie entfernen" onClick={(e) => (e.stopPropagation(), removeNode(n.id))}>
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {nodes.length === 0 && <div className="topo-empty">Noch keine Komponenten zugewiesen...</div>}
          </>
        )}
      </section>
    );
  };

  return (
    <Card
      title="Topologie"
      sub="Feste Ebenen, oben das AI Gateway, unten das Rechenzentrum. Füge mit „+“ Komponenten aus dem Inventar hinzu und klicke eine Komponente an, um sie zu konfigurieren."
      action={
        <span className="btn-row" style={{ flexWrap: 'nowrap' }}>
          <label className="checkbox">
            <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} /> Verbindungen anzeigen
          </label>
          {editable && (
            <button className="btn sm primary" onClick={save} disabled={busy || !dirty}>
              <Save size={13} /> {dirty ? 'Speichern' : 'Gespeichert'}
            </button>
          )}
        </span>
      }
    >
      <ErrorBox error={error} />
      {warnings.map((w) => (
        <div key={w} className="hint" style={{ color: 'var(--warn, #c77d12)' }}>
          Hinweis: {w}
        </div>
      ))}
      <div className="topo-scroll">
        <div ref={frame} className="topo-frame" style={{ minWidth: colCount * (COL_W + COL_GAP) + 24 }}>
          {showLines && (
            <svg className="topo-lines" aria-hidden="true">
              {paths.map((p) => (
                <path key={p.key} d={p.d} />
              ))}
            </svg>
          )}
          {mainLayers.map(renderLayer)}
          <section className="topo-optional">
            <header>
              <button className="btn sm ghost" onClick={() => setOptionalOpen((o) => !o)} aria-expanded={optionalOpen} aria-label="Optionale Komponenten ein- oder ausklappen">
                {optionalOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              <strong>Optionale Komponenten</strong>
              <span className="sub">MCP, Datenbanken, Observability, IAM{optionalCount ? ` · ${optionalCount} zugewiesen` : ''}</span>
            </header>
            {optionalOpen && <div className="topo-optional-body">{optionalLayers.map(renderLayer)}</div>}
          </section>
        </div>
      </div>
      {selNode && (
        <Modal
          title={`${selNode.name} konfigurieren`}
          onClose={() => setSelected(null)}
          footer={
            <>
              {editable && (
                <button className="btn danger" onClick={() => removeNode(selNode.id)}>
                  Aus Topologie nehmen
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button className="btn primary" onClick={() => setSelected(null)}>
                Fertig
              </button>
            </>
          }
        >
          <ConfigBar key={selNode.id} node={selNode} m={model} />
        </Modal>
      )}
      {adding && (
        <Modal title={`${adding.label}: Komponente hinzufügen`} onClose={() => setAdding(null)}>
          {candidates(adding).length === 0 ? (
            <div className="hint">Im Inventar gibt es keine weitere Komponente dieser Art. Lege sie im Tab Inventar an.</div>
          ) : (
            <div className="btn-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {candidates(adding).map((e) => (
                <button key={e.id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => addNode(adding.key, e.id)}>
                  {e.name} <span className="sub">{KIND_META[e.kind]?.label}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}

function summaryOf(n, m, served) {
  const s = n.spec ?? {};
  if (n.kind === 'server') return [s.server_type === 'gpu' ? 'GPU-Server' : 'CPU-Server', m.gpusOf(n.id).length ? `${m.gpusOf(n.id).length} GPU` : null].filter(Boolean).join(' · ');
  if (n.kind === 'kubernetes') return `${(s.nodes ?? []).length} Knoten`;
  if (n.kind === 'llm') return `${(served[n.id] ?? []).length} Modell(e)`;
  if (n.kind === 'ai_proxy') return `${m.rows.filter((r) => r.gateway_id === n.id).length} Route(n)`;
  if (n.kind === 'iam') return `${(s.services ?? []).length} Dienst(e)${s.enterprise_accounts ? ' · Enterprise' : ''}`;
  if (n.kind === 'interconnect') return `${m.presets.interconnect_types.find((t) => t.key === s.type)?.label ?? ''}`;
  return KIND_META[n.kind]?.label ?? '';
}
