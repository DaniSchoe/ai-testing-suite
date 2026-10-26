import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Lock, LockOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, can, Card, EnvBadge, Empty, envParam, ErrorBox, Field, fmt, KIND_META, Loading, Modal, PageHead, StatusBadge, Tabs, useAction, useApi, useUser } from '../lib.jsx';
import Components from './admin/Components.jsx';

export function Platforms() {
  const user = useUser();
  const list = useApi(`/api/platforms${envParam()}`);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead
        title="Plattformen"
        action={
          can(user, 'endpoints.manage') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Neue Plattform
            </button>
          )
        }
      >
        Eine Plattform fasst Gateway, Modell-Server und MCP-Server eines Systems zusammen. Prüfungen richten sich immer gegen eine Plattform; Dev und Prod sind getrennte Plattformen.
      </PageHead>
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Noch keine Plattform. Lege eine an und füge Komponenten hinzu.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Umgebung</th>
                    <th>Komponenten</th>
                    <th>Modelle</th>
                    <th>Letzter Lauf</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link className="title-link" to={`/platforms/${p.id}`}>
                          {p.name}
                        </Link>
                        {p.locked && (
                          <span className="badge failed" style={{ marginLeft: 8 }}>
                            <Lock size={11} /> gesperrt
                          </span>
                        )}
                        {p.description && <div className="sub">{p.description}</div>}
                      </td>
                      <td>
                        <EnvBadge env={p.environment} />
                      </td>
                      <td className="sub">
                        {p.components} ({(p.kinds ?? []).map((k) => KIND_META[k]?.label ?? k).join(', ') || '–'})
                      </td>
                      <td>{p.models}</td>
                      <td>
                        {p.last_status ? <StatusBadge status={p.last_status} /> : '–'}
                        <div className="sub">{fmt.ago(p.last_run_at)}</div>
                      </td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
      {creating && <PlatformForm onClose={() => setCreating(false)} onSaved={() => (setCreating(false), list.reload())} />}
    </>
  );
}

function PlatformForm({ platform, onClose, onSaved }) {
  const [form, setForm] = useState({ name: platform?.name ?? '', description: platform?.description ?? '', environment: platform?.environment ?? 'dev' });
  const [run, error] = useAction();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const save = () =>
    run(async () => {
      const saved = await api(platform ? `/api/platforms/${platform.id}` : '/api/platforms', { method: platform ? 'PUT' : 'POST', body: form });
      onSaved(saved);
    });
  return (
    <Modal
      title={platform ? 'Plattform bearbeiten' : 'Neue Plattform'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save} disabled={!form.name.trim()}>
            Speichern
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name">
        <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Beschreibung">
        <input value={form.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Umgebung" hint="Prod-Läufe brauchen eine Freigabe (Vier-Augen-Prinzip). Die Umgebung gilt für alle Komponenten.">
        <select value={form.environment} onChange={(e) => set({ environment: e.target.value })}>
          <option value="dev">Dev</option>
          <option value="prod">Prod</option>
        </select>
      </Field>
    </Modal>
  );
}

export function PlatformDetail() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const platform = useApi(`/api/platforms/${id}`);
  const status = useApi(`/api/platforms/${id}/status`, { interval: 60000 });
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [run, error] = useAction();
  const manager = can(user, 'endpoints.manage');
  const approver = can(user, 'runs.prod');

  async function lock() {
    const reason = prompt('Grund für die Sperre (Kill-Switch). Laufende Läufe werden abgebrochen:');
    if (reason === null) return;
    await run(async () => {
      await api(`/api/platforms/${id}/lock`, { method: 'POST', body: { reason } });
      platform.reload();
    });
  }
  const unlock = () =>
    run(async () => {
      await api(`/api/platforms/${id}/unlock`, { method: 'POST' });
      platform.reload();
    });
  const remove = () =>
    confirm('Plattform mit allen Komponenten löschen?') &&
    run(async () => {
      await api(`/api/platforms/${id}`, { method: 'DELETE' });
      navigate('/platforms');
    });

  return (
    <Loading state={platform}>
      {(p) => (
        <>
          <PageHead
            title={
              <>
                {p.name} <EnvBadge env={p.environment} />
              </>
            }
            action={
              <div className="btn-row">
                {approver && (p.locked ? (
                  <button className="btn" onClick={unlock}>
                    <LockOpen size={15} /> Entsperren
                  </button>
                ) : (
                  <button className="btn danger" onClick={lock}>
                    <Lock size={15} /> Sperren
                  </button>
                ))}
                {manager && (
                  <>
                    <button className="btn" onClick={() => setEditing(true)}>
                      Bearbeiten
                    </button>
                    <button className="btn ghost danger" onClick={remove} aria-label="Löschen">
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            }
          >
            {p.description}
          </PageHead>
          <ErrorBox error={error} />
          {p.locked && (
            <div className="error-box">
              Gesperrt{p.locked_reason ? `: ${p.locked_reason}` : ''} seit {fmt.date(p.locked_at)}. Es starten keine Läufe gegen diese Plattform.
            </div>
          )}
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['overview', 'Status'],
              ['components', `Komponenten (${p.endpoints.length})`],
              ['topology', 'Topologie'],
              ['sovereignty', 'Souveränitätsziele'],
            ]}
          />
          {tab === 'overview' && <Overview platform={p} status={status} />}
          {tab === 'components' && <Components platform={p} onChanged={platform.reload} />}
          {tab === 'topology' && <Topology platform={p} editable={manager} onSaved={platform.reload} />}
          {tab === 'sovereignty' && <SovereigntyEditor platform={p} editable={manager} onSaved={platform.reload} />}
          {editing && <PlatformForm platform={p} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), platform.reload())} />}
        </>
      )}
    </Loading>
  );
}

function Overview({ platform, status }) {
  return (
    <Card
      title="Komponenten"
      sub={status.data ? `Stand ${fmt.date(status.data.at)}` : 'Prüfe…'}
      action={
        <button className="btn sm" onClick={() => api(`/api/platforms/${platform.id}/status?force=1`).then(status.reload)}>
          <RefreshCw size={13} /> Neu prüfen
        </button>
      }
      flush
    >
      <table>
        <thead>
          <tr>
            <th>Komponente</th>
            <th>Art</th>
            <th>Status</th>
            <th>Version</th>
            <th>Antwortzeit</th>
          </tr>
        </thead>
        <tbody>
          {(status.data?.components ?? []).map((c) => (
            <tr key={c.endpoint_id}>
              <td>{c.name}</td>
              <td>{KIND_META[c.kind]?.label ?? c.kind}</td>
              <td>
                <span className={`badge ${c.status === 'up' ? 'passed' : 'failed'}`}>{c.status === 'up' ? 'erreichbar' : 'gestört'}</span>
                {c.error && <div className="sub">{c.error}</div>}
              </td>
              <td className="sub">{c.version ?? '–'}</td>
              <td>{fmt.ms(c.latency_ms)}</td>
            </tr>
          ))}
          {status.data?.components.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                Noch keine Komponenten.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

// Welches Gateway reicht an welches Backend weiter, für welche Modelle.
function Topology({ platform, editable, onSaved }) {
  const gateways = platform.endpoints.filter((e) => e.kind === 'ai_proxy');
  const backends = platform.endpoints.filter((e) => e.kind !== 'ai_proxy' && e.kind !== 'mcp');
  const [routes, setRoutes] = useState(platform.routes.map((r) => ({ ...r, models: (r.models ?? []).join(', ') })));
  const [run, error, busy] = useAction();
  const update = (i, patch) => setRoutes((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const name = (id) => platform.endpoints.find((e) => e.id === id)?.name ?? '?';
  const save = () =>
    run(async () => {
      await api(`/api/platforms/${platform.id}/routes`, {
        method: 'PUT',
        body: {
          routes: routes.map((r) => ({
            gateway_endpoint_id: r.gateway_endpoint_id,
            backend_endpoint_id: r.backend_endpoint_id,
            models: r.models.split(',').map((m) => m.trim()).filter(Boolean),
            note: r.note || null,
          })),
        },
      });
      onSaved();
    });
  return (
    <Card
      title="Topologie"
      sub="Der Pfad „direkt“ spricht ein Backend an, der Pfad „Gateway“ geht über die hier eingetragene Route. Ohne Route gilt ein Modell nur direkt."
      action={
        editable && (
          <div className="btn-row">
            <button
              className="btn sm"
              disabled={!gateways.length || !backends.length}
              onClick={() => setRoutes([...routes, { gateway_endpoint_id: gateways[0]?.id, backend_endpoint_id: backends[0]?.id, models: '', note: '' }])}
            >
              <Plus size={13} /> Route
            </button>
            <button className="btn sm primary" onClick={save} disabled={busy}>
              Speichern
            </button>
          </div>
        )
      }
    >
      <ErrorBox error={error} />
      {routes.length === 0 && <Empty>Keine Routen. {gateways.length === 0 ? 'Füge zuerst ein Gateway (AI Proxy) hinzu.' : ''}</Empty>}
      {routes.map((r, i) => (
        <div key={i} className="form-grid" style={{ alignItems: 'end', marginBottom: 8 }}>
          <Field label="Gateway">
            <select value={r.gateway_endpoint_id} disabled={!editable} onChange={(e) => update(i, { gateway_endpoint_id: e.target.value })}>
              {gateways.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Backend">
            <select value={r.backend_endpoint_id} disabled={!editable} onChange={(e) => update(i, { backend_endpoint_id: e.target.value })}>
              {backends.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Modelle (Komma, leer = alle)">
            <input value={r.models} disabled={!editable} onChange={(e) => update(i, { models: e.target.value })} />
          </Field>
          {editable && (
            <button className="btn ghost danger" onClick={() => setRoutes(routes.filter((_, j) => j !== i))} aria-label="Route entfernen">
              <Trash2 size={14} />
            </button>
          )}
          <div className="sub" style={{ gridColumn: '1 / -1' }}>
            {name(r.gateway_endpoint_id)} → {name(r.backend_endpoint_id)}
          </div>
        </div>
      ))}
    </Card>
  );
}

function SovereigntyEditor({ platform, editable, onSaved }) {
  const overview = useApi(`/api/sovereignty?platform_id=${platform.id}`);
  const [goals, setGoals] = useState(platform.sovereignty?.goals ?? {});
  const [minLevel, setMinLevel] = useState(platform.sovereignty?.min_level ?? 2);
  const [run, error, busy] = useAction();
  const defs = overview.data?.find((o) => o.platform.id === platform.id)?.goals ?? overview.data?.[0]?.goals ?? [];
  const save = () =>
    run(async () => {
      await api(`/api/platforms/${platform.id}/sovereignty`, { method: 'PUT', body: { min_level: minLevel, goals } });
      onSaved();
    });
  const set = (key, patch) => setGoals((g) => ({ ...g, [key]: { level: 0, note: '', ...g[key], ...patch } }));
  return (
    <Card
      title="Deklarierte Souveränitätsziele"
      sub="Stufe 0 bis 4 je Ziel (SEAL). Gemessene Prüfergebnisse können die Stufe nur absenken, nie erhöhen: wirksam ist das Minimum aus Erklärung und Messung."
      action={
        editable && (
          <button className="btn sm primary" onClick={save} disabled={busy}>
            Speichern
          </button>
        )
      }
    >
      <ErrorBox error={error} />
      <Field label="Geforderte Mindeststufe">
        <select value={minLevel} disabled={!editable} onChange={(e) => setMinLevel(Number(e.target.value))}>
          {[0, 1, 2, 3, 4].map((l) => (
            <option key={l} value={l}>
              SEAL-{l}
            </option>
          ))}
        </select>
      </Field>
      {defs.map((g) => (
        <div key={g.key} className="form-grid" style={{ alignItems: 'end', marginBottom: 8 }}>
          <Field label={`${g.key} ${g.name}`}>
            <select value={goals[g.key]?.level ?? ''} disabled={!editable} onChange={(e) => (e.target.value === '' ? setGoals(({ [g.key]: _, ...rest }) => rest) : set(g.key, { level: Number(e.target.value) }))}>
              <option value="">nicht erklärt</option>
              {[0, 1, 2, 3, 4].map((l) => (
                <option key={l} value={l}>
                  SEAL-{l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Begründung">
            <input value={goals[g.key]?.note ?? ''} disabled={!editable || !goals[g.key]} onChange={(e) => set(g.key, { note: e.target.value })} />
          </Field>
        </div>
      ))}
    </Card>
  );
}
