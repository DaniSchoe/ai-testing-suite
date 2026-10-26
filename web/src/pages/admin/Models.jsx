import { useMemo, useState } from 'react';
import { Pencil, RefreshCw } from 'lucide-react';
import {
  api,
  can,
  EnvBadge,
  fmt,
  KindBadge,
  Modal,
  PUBLISH_LABEL,
  TeamPicker,
  useApi,
  useTeams,
  useUser,
  useUserDirectory,
  VisibilityBadge,
} from '../../lib.jsx';

// Modellkatalog: alle per Modellliste gefundenen Modelle. Der Alias führt gleiche Modelle mit
// unterschiedlichen Namen zusammen (z. B. "Qwen/Qwen3-32B" am vLLM-Endpunkt und "qwen3-32b" in LiteLLM).
// Bearbeiten dürfen Administratoren und der Maintainer des Modells.
export default function Models() {
  const me = useUser();
  const models = useApi('/api/models');
  const endpoints = useApi('/api/endpoints');
  const teams = useTeams();
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState(null);
  const [envFilter, setEnvFilter] = useState('all');
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';
  const manager = can(me, 'endpoints.manage');

  const groups = useMemo(() => {
    const map = new Map();
    for (const m of (models.data ?? []).filter((x) => envFilter === 'all' || x.effective_environment === envFilter)) {
      const key = m.alias ?? m.name;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    return [...map.entries()];
  }, [models.data, envFilter]);

  async function syncAll() {
    setSyncing(true);
    setMessage(null);
    const targets = (endpoints.data ?? []).filter((e) => e.kind !== 'mcp' && e.enabled);
    const results = await Promise.all(
      targets.map((e) =>
        api(`/api/endpoints/${e.id}/sync-models`, { method: 'POST' })
          .then((r) => ({ name: e.name, ...r }))
          .catch((err) => ({ name: e.name, ok: false, error: err.message })),
      ),
    );
    const failed = results.filter((r) => !r.ok);
    setMessage(failed.length ? `Abruf fehlgeschlagen für: ${failed.map((f) => f.name).join(', ')}` : `${targets.length} Endpoints abgefragt`);
    setSyncing(false);
    models.reload();
    endpoints.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Modellkatalog</h1>
          <p>
            Modelle aller Endpoints, automatisch abgefragt. Vergib einen gemeinsamen Alias, wenn dasselbe Modell in vLLM und LiteLLM unterschiedlich
            heißt. Tests und Dashboard verwenden den Alias. Dev/Prod und Veröffentlichung gelten wie bei Endpoints; bearbeiten dürfen Administratoren
            und der Maintainer des Modells.
          </p>
        </div>
        {manager && (
          <button className="btn primary" onClick={syncAll} disabled={syncing}>
            <RefreshCw size={15} /> {syncing ? 'Frage ab…' : 'Alle Modelle abfragen'}
          </button>
        )}
      </div>
      {message && <div className="error-box" style={{ background: 'var(--primary-soft)', color: 'var(--primary-text)' }}>{message}</div>}
      <div className="card">
        <div className="toolbar">
          <div className="segmented" role="tablist" aria-label="Umgebung">
            {[
              ['all', 'Alle'],
              ['prod', 'Prod'],
              ['dev', 'Dev'],
            ].map(([k, label]) => (
              <button key={k} className={envFilter === k ? 'active' : ''} onClick={() => setEnvFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Endpoint</th>
                <th>Name am Endpoint</th>
                <th>Maintainer</th>
                <th>Umgebung</th>
                <th>Veröffentlicht</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map(([alias, rows]) =>
                rows.map((m, i) => (
                  <tr key={`${m.endpoint_id}:${m.name}`} style={i === 0 ? undefined : { borderTop: 0 }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{alias}</div>
                      {i === 0 && rows.length > 1 && <div className="sub">{rows.length} Endpoints bieten „{alias}“ an</div>}
                    </td>
                    <td>
                      {m.endpoint_name} <KindBadge kind={m.endpoint_kind} />
                    </td>
                    <td>
                      <code>{m.name}</code>
                      {m.source === 'manual' && <div className="sub">manuell eingetragen</div>}
                    </td>
                    <td className="sub">{m.maintainer_name ?? '–'}</td>
                    <td>
                      <EnvBadge env={m.effective_environment} />
                      {m.effective_environment !== m.environment && <div className="sub">über Endpoint</div>}
                    </td>
                    <td>
                      <VisibilityBadge visibility={m.visibility} teamNames={m.teamIds.map(teamName)} />
                    </td>
                    <td>
                      {m.available ? <span className="badge passed">✓ verfügbar</span> : <span className="badge warn">– nicht mehr gelistet</span>}
                      <div className="sub">{m.source === 'manual' ? '' : fmt.ago(m.last_seen_at)}</div>
                    </td>
                    <td className="num">
                      {m.can_edit && (
                        <button className="btn sm ghost" onClick={() => setEditing(m)} aria-label={`${m.name} bearbeiten`}>
                          <Pencil size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                )),
              )}
              {models.data?.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    Noch keine Modelle. Lege Endpoints an und frage die Modelle ab.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {editing && (
        <ModelEditor
          model={editing}
          teams={teams.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            models.reload();
          }}
        />
      )}
    </>
  );
}

function ModelEditor({ model, teams, onClose, onSaved }) {
  const users = useUserDirectory();
  const [form, setForm] = useState({
    alias: model.alias ?? '',
    maintainer_id: model.maintainer_id ?? '',
    environment: model.environment ?? 'prod',
    visibility: model.visibility ?? 'global',
  });
  const [teamIds, setTeamIds] = useState(model.teamIds ?? []);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    try {
      await api('/api/endpoint-models', {
        method: 'PUT',
        body: { endpoint_id: model.endpoint_id, name: model.name, ...form, maintainer_id: form.maintainer_id || null, teamIds },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={`Modell ${model.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      <div className="hint" style={{ marginBottom: 12 }}>
        Am Endpoint <strong>{model.endpoint_name}</strong>
      </div>
      <label className="field">
        <span>Alias</span>
        <input value={form.alias} placeholder={model.name} onChange={(e) => set({ alias: e.target.value })} />
      </label>
      <label className="field">
        <span>Maintainer</span>
        <select value={form.maintainer_id} onChange={(e) => set({ maintainer_id: e.target.value })}>
          <option value="">– keiner –</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Umgebung</span>
          <select value={form.environment} onChange={(e) => set({ environment: e.target.value })}>
            <option value="prod">Prod</option>
            <option value="dev">Dev</option>
          </select>
        </label>
        <label className="field">
          <span>Veröffentlicht für</span>
          <select value={form.visibility} onChange={(e) => set({ visibility: e.target.value })}>
            {Object.entries(PUBLISH_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      {form.visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}
    </Modal>
  );
}
