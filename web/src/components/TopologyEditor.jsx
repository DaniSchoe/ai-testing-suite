// Topologie per Drag & Drop: Komponenten aus dem Inventar auf die Fläche ziehen und verbinden.
// Verbindungen: Standort (GPU/Kubernetes → Rechenzentrum), Cluster (GPU → Kubernetes), Betrieb (Inferenzserver → GPU, bei MIG je Instanz)
// und Route (AI Gateway → Inferenzserver, mit den Modellen, die über das Gateway laufen).
import { useMemo, useRef, useState } from 'react';
import { Link2, Save, Trash2, X } from 'lucide-react';
import { api, Card, ErrorBox, KIND_META, Modal, useAction } from '../lib.jsx';

const NODE_W = 176;
const NODE_H = 70;
const COLUMN = { datacenter: 0, kubernetes: 1, gpu: 2, llm: 3, ai_proxy: 4, mcp: 5, vector_db: 5, iam: 5, observability: 5 };
const LINK_LABEL = { hosted_in: 'steht in', cluster: 'Teil von', runs_on: 'läuft auf', route: 'Route' };
const LINK_STYLE = {
  hosted_in: { stroke: '#8a8f98', dash: '4 4' },
  cluster: { stroke: '#8a8f98', dash: '' },
  runs_on: { stroke: '#1a9b5f', dash: '' },
  route: { stroke: '#5064dc', dash: '' },
};

// Welche Verbindung entsteht zwischen zwei Arten? null = nicht erlaubt.
function linkKind(from, to) {
  if (from.kind === 'llm' && to.kind === 'gpu') return 'runs_on';
  if (from.kind === 'gpu' && to.kind === 'kubernetes') return 'cluster';
  if ((from.kind === 'gpu' || from.kind === 'kubernetes') && to.kind === 'datacenter') return 'hosted_in';
  if (from.kind === 'ai_proxy' && to.kind === 'llm') return 'route';
  return null;
}

const edgeKey = (e) => `${e.kind}|${e.from_id}|${e.to_id}|${e.slice ?? ''}`;

function initialState(platform) {
  const links = platform.links.map((l) => ({ kind: l.kind, from_id: l.from_id, to_id: l.to_id, slice: l.data?.mig_slice ?? null }));
  const routes = platform.routes.map((r) => ({ kind: 'route', from_id: r.gateway_endpoint_id, to_id: r.backend_endpoint_id, models: r.models ?? [] }));
  const layout = { ...(platform.layout ?? {}) };
  const counters = {};
  for (const e of platform.endpoints) {
    const used = [...links, ...routes].some((l) => l.from_id === e.id || l.to_id === e.id);
    if (!layout[e.id] && used) {
      const col = COLUMN[e.kind] ?? 5;
      counters[col] = (counters[col] ?? 0) + 1;
      layout[e.id] = { x: 20 + col * 220, y: 20 + (counters[col] - 1) * 100 };
    }
  }
  return { edges: [...links, ...routes], layout };
}

export default function TopologyEditor({ platform, editable, onSaved }) {
  const init = useMemo(() => initialState(platform), [platform]);
  const [edges, setEdges] = useState(init.edges);
  const [layout, setLayout] = useState(init.layout);
  const [served, setServed] = useState(() => Object.fromEntries(platform.endpoints.filter((e) => e.kind === 'llm').map((e) => [e.id, e.spec?.served_models ?? []])));
  const [selected, setSelected] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [sliceChoice, setSliceChoice] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [run, error, busy] = useAction();
  const canvas = useRef(null);
  const drag = useRef(null);
  const byId = useMemo(() => new Map(platform.endpoints.map((e) => [e.id, e])), [platform]);

  const touch = () => setDirty(true);
  const placed = platform.endpoints.filter((e) => layout[e.id]);
  const unplaced = platform.endpoints.filter((e) => !layout[e.id]);
  const width = Math.max(1180, ...placed.map((e) => layout[e.id].x + NODE_W + 40));
  const height = Math.max(520, ...placed.map((e) => layout[e.id].y + NODE_H + 60));

  function place(id, x, y) {
    setLayout((l) => ({ ...l, [id]: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) } }));
    touch();
  }
  function remove(id) {
    setLayout(({ [id]: _, ...rest }) => rest);
    setEdges((es) => es.filter((e) => e.from_id !== id && e.to_id !== id));
    setSelected(null);
    touch();
  }

  function onDropCanvas(ev) {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    if (!byId.has(id)) return;
    const rect = canvas.current.getBoundingClientRect();
    place(id, ev.clientX - rect.left + canvas.current.scrollLeft - NODE_W / 2, ev.clientY - rect.top + canvas.current.scrollTop - NODE_H / 2);
  }

  function startMove(ev, id) {
    if (!editable || ev.target.closest('.topo-port')) return;
    drag.current = { id, dx: ev.clientX - layout[id].x, dy: ev.clientY - layout[id].y };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setSelected({ node: id });
  }
  function moveNode(ev) {
    if (!drag.current) return;
    place(drag.current.id, ev.clientX - drag.current.dx, ev.clientY - drag.current.dy);
  }
  const endMove = () => {
    drag.current = null;
  };

  function connect(targetId) {
    const from = byId.get(connecting);
    const to = byId.get(targetId);
    setConnecting(null);
    if (!from || !to || from.id === to.id) return;
    const kind = linkKind(from, to);
    if (!kind) {
      alert(`${KIND_META[from.kind].label} lässt sich nicht mit ${KIND_META[to.kind].label} verbinden.`);
      return;
    }
    if (kind === 'runs_on' && to.spec?.mig?.enabled) return setSliceChoice({ from, to });
    addEdge({ kind, from_id: from.id, to_id: to.id, slice: null, models: [] });
  }
  function addEdge(edge) {
    setEdges((es) => (es.some((e) => edgeKey(e) === edgeKey(edge)) ? es : [...es, edge]));
    setSelected({ edge: edgeKey(edge) });
    touch();
  }

  function save() {
    return run(async () => {
      const links = edges.filter((e) => e.kind !== 'route').map((e) => ({ kind: e.kind, from_id: e.from_id, to_id: e.to_id, data: e.slice === null || e.slice === undefined ? {} : { mig_slice: e.slice } }));
      const routes = edges.filter((e) => e.kind === 'route').map((e) => ({ gateway_endpoint_id: e.from_id, backend_endpoint_id: e.to_id, models: e.models ?? [] }));
      const res = await api(`/api/platforms/${platform.id}/topology`, { method: 'PUT', body: { links, routes, layout, served_models: served } });
      setWarnings(res.warnings ?? []);
      setDirty(false);
      onSaved();
    });
  }

  const center = (id) => ({ x: layout[id].x + NODE_W / 2, y: layout[id].y + NODE_H / 2 });
  const visible = edges.filter((e) => layout[e.from_id] && layout[e.to_id]);
  const selEdge = selected?.edge ? edges.find((e) => edgeKey(e) === selected.edge) : null;
  const selNode = selected?.node ? byId.get(selected.node) : null;

  return (
    <Card
      title="Topologie"
      sub="Ziehe Komponenten aus dem Inventar auf die Fläche. Über den Punkt rechts am Knoten und einen Klick auf das Ziel verbindest du sie: Inferenzserver → GPU, GPU → Kubernetes bzw. Rechenzentrum, Gateway → Inferenzserver (Route mit Modellen)."
      action={
        editable && (
          <button className="btn sm primary" onClick={save} disabled={busy || !dirty}>
            <Save size={13} /> {dirty ? 'Speichern' : 'Gespeichert'}
          </button>
        )
      }
    >
      <ErrorBox error={error} />
      {warnings.map((w) => (
        <div key={w} className="hint" style={{ color: 'var(--warn, #c77d12)' }}>
          Hinweis: {w}
        </div>
      ))}
      {connecting && (
        <div className="hint" style={{ marginBottom: 8 }}>
          Verbinde „{byId.get(connecting)?.name}“: klicke jetzt auf die Zielkomponente.{' '}
          <button className="btn sm" onClick={() => setConnecting(null)}>
            Abbrechen
          </button>
        </div>
      )}
      <div className="topo">
        <div className="topo-palette" aria-label="Inventar">
          <div className="sub">Inventar ({unplaced.length} nicht platziert)</div>
          {platform.endpoints.length === 0 && <div className="hint">Lege zuerst im Tab Komponenten Einträge an.</div>}
          {platform.endpoints.map((e) => {
            const meta = KIND_META[e.kind];
            return (
              <div
                key={e.id}
                className={`topo-chip${layout[e.id] ? ' placed' : ''}`}
                draggable={editable && !layout[e.id]}
                onDragStart={(ev) => ev.dataTransfer.setData('text/plain', e.id)}
                onDoubleClick={() => editable && !layout[e.id] && place(e.id, 20 + (COLUMN[e.kind] ?? 5) * 220, 20 + placed.filter((p) => p.kind === e.kind).length * 100)}
                title={layout[e.id] ? 'Bereits platziert' : 'Auf die Fläche ziehen (oder Doppelklick)'}
              >
                {meta && <meta.Icon size={14} style={{ color: meta.color }} />} {e.name}
              </div>
            );
          })}
        </div>
        <div>
          <div ref={canvas} className="topo-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDropCanvas} onClick={() => setSelected(null)}>
            <div style={{ position: 'relative', width, height }}>
              <svg className="topo-svg" width={width} height={height}>
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a8f98" />
                  </marker>
                </defs>
                {visible.map((e) => {
                  const a = center(e.from_id);
                  const b = center(e.to_id);
                  const style = LINK_STYLE[e.kind];
                  const key = edgeKey(e);
                  const active = selected?.edge === key;
                  const midX = (a.x + b.x) / 2;
                  const midY = (a.y + b.y) / 2;
                  return (
                    <g key={key}>
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14} style={{ pointerEvents: 'stroke', cursor: 'pointer' }} onClick={(ev) => (ev.stopPropagation(), setSelected({ edge: key }))} />
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.stroke} strokeWidth={active ? 3.5 : 2} strokeDasharray={style.dash} markerEnd="url(#arrow)" />
                      <text x={midX} y={midY - 6} textAnchor="middle" fontSize="11" fill="currentColor">
                        {e.kind === 'route' ? (e.models?.length ? e.models.join(', ').slice(0, 40) : 'alle Modelle') : e.kind === 'runs_on' && e.slice !== null && e.slice !== undefined ? `MIG ${e.slice + 1}` : LINK_LABEL[e.kind]}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {placed.map((e) => {
                const meta = KIND_META[e.kind];
                const pos = layout[e.id];
                const isSel = selected?.node === e.id || connecting === e.id;
                return (
                  <div
                    key={e.id}
                    className={`topo-node${isSel ? ' selected' : ''}`}
                    style={{ left: pos.x, top: pos.y, width: NODE_W, minHeight: NODE_H, cursor: editable ? 'grab' : 'default' }}
                    onPointerDown={(ev) => startMove(ev, e.id)}
                    onPointerMove={moveNode}
                    onPointerUp={endMove}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (connecting) connect(e.id);
                      else setSelected({ node: e.id });
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
                      {meta && <meta.Icon size={14} style={{ color: meta.color }} />} <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                    </div>
                    <div className="sub" style={{ fontSize: 11 }}>
                      {meta?.label}
                      {e.kind === 'gpu' && e.spec?.mig?.enabled && ` · MIG ${e.spec.mig.layout.length}×`}
                      {e.kind === 'llm' && (served[e.id] ?? []).length > 0 && ` · ${(served[e.id] ?? []).length} Modell(e)`}
                    </div>
                    {e.kind === 'gpu' && e.spec?.mig?.enabled && (
                      <div style={{ display: 'flex', gap: 3, marginTop: 4, flexWrap: 'wrap' }}>
                        {e.spec.mig.layout.map((l, i) => (
                          <span key={i} className="tag" style={{ fontSize: 10, padding: '0 4px' }}>
                            {l.profile}
                          </span>
                        ))}
                      </div>
                    )}
                    {editable && (
                      <span
                        className="topo-port"
                        style={{ right: -6 }}
                        title="Verbinden"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setConnecting(e.id);
                        }}
                      />
                    )}
                  </div>
                );
              })}
              {placed.length === 0 && <div className="empty" style={{ position: 'absolute', inset: 0 }}>Ziehe Komponenten aus dem Inventar hierher.</div>}
            </div>
          </div>

          {selNode && (
            <NodeDetails
              node={selNode}
              editable={editable}
              served={served[selNode.id] ?? []}
              onServed={(v) => (setServed((s) => ({ ...s, [selNode.id]: v })), touch())}
              onConnect={() => setConnecting(selNode.id)}
              onRemove={() => remove(selNode.id)}
            />
          )}
          {selEdge && (
            <EdgeDetails
              edge={selEdge}
              byId={byId}
              served={served}
              editable={editable}
              onChange={(patch) => (setEdges((es) => es.map((e) => (edgeKey(e) === edgeKey(selEdge) ? { ...e, ...patch } : e))), setSelected({ edge: edgeKey({ ...selEdge, ...patch }) }), touch())}
              onRemove={() => (setEdges((es) => es.filter((e) => edgeKey(e) !== edgeKey(selEdge))), setSelected(null), touch())}
            />
          )}
        </div>
      </div>
      {sliceChoice && (
        <SliceDialog
          gpu={sliceChoice.to}
          onClose={() => setSliceChoice(null)}
          onPick={(slice) => {
            addEdge({ kind: 'runs_on', from_id: sliceChoice.from.id, to_id: sliceChoice.to.id, slice, models: [] });
            setSliceChoice(null);
          }}
        />
      )}
    </Card>
  );
}

function NodeDetails({ node, editable, served, onServed, onConnect, onRemove }) {
  const models = (node.models ?? []).filter((m) => m.available).map((m) => m.name);
  const set = new Set(served);
  return (
    <div className="card" style={{ marginTop: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>{node.name}</strong>
        <span className="sub">{KIND_META[node.kind]?.label}</span>
        <span style={{ flex: 1 }} />
        {editable && (
          <>
            <button className="btn sm" onClick={onConnect}>
              <Link2 size={13} /> Verbinden
            </button>
            <button className="btn sm ghost danger" onClick={onRemove}>
              <X size={13} /> Von Fläche nehmen
            </button>
          </>
        )}
      </div>
      {node.kind === 'llm' && (
        <div style={{ marginTop: 8 }}>
          <div className="sub">Modelle auf diesem Inferenzserver (aus /v1/models)</div>
          {models.length === 0 && <div className="hint">Keine Modelle gefunden. Verbindung unter Komponenten testen.</div>}
          <div className="pick-list" style={{ maxHeight: 150 }}>
            {models.map((m) => (
              <label key={m}>
                <input type="checkbox" disabled={!editable} checked={set.has(m)} onChange={() => onServed(set.has(m) ? served.filter((x) => x !== m) : [...served, m])} />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EdgeDetails({ edge, byId, served, editable, onChange, onRemove }) {
  const from = byId.get(edge.from_id);
  const to = byId.get(edge.to_id);
  const options = edge.kind === 'route' ? (served[edge.to_id]?.length ? served[edge.to_id] : (to?.models ?? []).filter((m) => m.available).map((m) => m.name)) : [];
  const set = new Set(edge.models ?? []);
  return (
    <div className="card" style={{ marginTop: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>
          {from?.name} → {to?.name}
        </strong>
        <span className="sub">{LINK_LABEL[edge.kind]}</span>
        <span style={{ flex: 1 }} />
        {editable && (
          <button className="btn sm ghost danger" onClick={onRemove}>
            <Trash2 size={13} /> Verbindung löschen
          </button>
        )}
      </div>
      {edge.kind === 'route' && (
        <div style={{ marginTop: 8 }}>
          <div className="sub">Modelle, die das Gateway an diesen Inferenzserver weiterleitet (keine Auswahl = alle)</div>
          <div className="pick-list" style={{ maxHeight: 150 }}>
            {options.map((m) => (
              <label key={m}>
                <input type="checkbox" disabled={!editable} checked={set.has(m)} onChange={() => onChange({ models: set.has(m) ? edge.models.filter((x) => x !== m) : [...(edge.models ?? []), m] })} />
                <span>{m}</span>
              </label>
            ))}
            {options.length === 0 && <div className="hint">Der Inferenzserver hat keine Modelle.</div>}
          </div>
        </div>
      )}
      {edge.kind === 'runs_on' && to?.spec?.mig?.enabled && (
        <label className="field" style={{ marginTop: 8 }}>
          <span>MIG-Instanz</span>
          <select
            disabled={!editable}
            value={edge.slice ?? ''}
            onChange={(e) => onChange({ slice: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">ganze GPU</option>
            {to.spec.mig.layout.map((l, i) => (
              <option key={i} value={i}>
                Instanz {i + 1}: {l.profile}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function SliceDialog({ gpu, onClose, onPick }) {
  return (
    <Modal title={`Auf welcher Instanz von ${gpu.name} läuft der Inferenzserver?`} onClose={onClose}>
      <p className="hint" style={{ marginTop: 0 }}>
        Die GPU ist mit MIG geteilt. Wähle die Instanz oder die ganze GPU.
      </p>
      <div className="btn-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        {gpu.spec.mig.layout.map((l, i) => (
          <button key={i} className="btn" onClick={() => onPick(i)}>
            Instanz {i + 1}: {l.profile} ({l.memory_gb ?? '?'} GB)
          </button>
        ))}
        <button className="btn" onClick={() => onPick(null)}>
          Ganze GPU
        </button>
      </div>
    </Modal>
  );
}
