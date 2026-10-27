import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Lock, LockOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, can, Card, EnvBadge, Empty, ErrorBox, Field, fmt, KIND_META, Loading, STATUS_KINDS, Modal, PageHead, StatusBadge, Tabs, useAction, useApi, useUser } from '../lib.jsx';
import Components from './admin/Components.jsx';
import TopologyEditor from '../components/TopologyEditor.jsx';
import { AssessmentView } from '../components/Assessment.jsx';

export function Platforms() {
  const user = useUser();
  const list = useApi('/api/platforms');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead
        title="Komponenten"
        action={
          can(user, 'endpoints.manage') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Neue Plattform
            </button>
          )
        }
      >
        Eine Plattform beschreibt ein System vom Rechenzentrum über Kubernetes und GPUs bis zu Inferenzservern und AI Gateway. Prüfungen richten sich immer gegen eine Plattform; Dev und Prod sind getrennte Plattformen.
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
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') ?? 'overview');
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
              ['components', `Inventar (${p.endpoints.length})`],
              ['topology', 'Topologie'],
              ['assessment', 'Einstufung'],
            ]}
          />
          {tab === 'overview' && <Overview platform={p} status={status} />}
          {tab === 'components' && <Components platform={p} onChanged={platform.reload} />}
          {tab === 'topology' && <TopologyEditor key={p.updated_at} platform={p} editable={manager} onSaved={platform.reload} />}
          {tab === 'assessment' && <AssessmentView platformId={p.id} editable={manager} />}
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
          {(status.data?.components ?? []).filter((c) => STATUS_KINDS.includes(c.kind)).map((c) => (
            <tr key={c.endpoint_id}>
              <td>{c.name}</td>
              <td>{KIND_META[c.kind]?.label ?? c.kind}</td>
              <td>
                {c.status === 'n/a' ? <span className="sub">nicht überwacht</span> : <span className={`badge ${c.status === 'up' ? 'passed' : 'failed'}`}>{c.status === 'up' ? 'erreichbar' : 'gestört'}</span>}
                {c.error && <div className="sub">{c.error}</div>}
              </td>
              <td className="sub">{c.version ?? '–'}</td>
              <td>{fmt.ms(c.latency_ms)}</td>
            </tr>
          ))}
          {status.data && !status.data.components.some((c) => STATUS_KINDS.includes(c.kind)) && (
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
