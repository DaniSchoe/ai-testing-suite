import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  api,
  can,
  EnvBadge,
  ErrorBox,
  getPlatform,
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

// Modellportfolio: fachliche Modelle, die du aus den gefundenen Modellen der Endpoints zusammenstellst. Ein Portfolio-Modell kann mehrere
// gefundene Modelle bündeln (z. B. "Gemma-31B" am vLLM und "gemma4-31b" in LiteLLM). Nur Portfolio-Modelle werden getestet und bewertet.
export default function Models() {
  const me = useUser();
  const portfolio = useApi('/api/portfolio');
  const models = useApi('/api/models');
  const teams = useTeams();
  const [editing, setEditing] = useState(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState(null);
  const platformId = getPlatform();
  const manager = can(me, 'endpoints.manage');
  const teamName = (id) => teams.data?.find((t) => t.id === id)?.name ?? '…';
  const rows = useMemo(() => (portfolio.data ?? []).filter((m) => all || !platformId || m.members.some((x) => x.platform_id === platformId)), [portfolio.data, all, platformId]);

  async function remove(m) {
    if (!confirm(`„${m.name}“ aus dem Portfolio entfernen? Die gefundenen Modelle bleiben an den Endpoints erhalten.`)) return;
    try {
      await api(`/api/portfolio/${m.id}`, { method: 'DELETE' });
      portfolio.reload();
      models.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Modellportfolio</h1>
          <p>
            Modelle erscheinen nicht mehr automatisch. Beim Anlegen wählst du aus den gefundenen Modellen der Endpoints ein oder mehrere aus und gibst dem Modell einen Namen,
            z. B. „Gemma4-31B“ für LiteLLM/Gemma4-31B und vLLM/Gemma-31B. Tests und Dashboard verwenden diesen Namen.
          </p>
        </div>
        {manager && (
          <button className="btn primary" onClick={() => setEditing({})}>
            <Plus size={15} /> Neues Modell
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <div className="toolbar">
          <div className="segmented" role="tablist" aria-label="Umfang">
            <button className={!all ? 'active' : ''} onClick={() => setAll(false)}>
              Gewählte Plattform
            </button>
            <button className={all ? 'active' : ''} onClick={() => setAll(true)}>
              Alle
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Modell</th>
                <th>Gefundene Modelle</th>
                <th>Metadaten</th>
                <th>Maintainer</th>
                <th>Veröffentlicht</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link className="title-link" to={`/models/${encodeURIComponent(m.name)}`}>
                      {m.name}
                    </Link>
                    {m.description && <div className="sub">{m.description}</div>}
                    <div className="sub">{(m.capabilities ?? []).join(', ')}</div>
                  </td>
                  <td>
                    {m.members.map((x) => (
                      <div key={`${x.endpoint_id}:${x.model_name}`} style={{ marginBottom: 2 }}>
                        <code>{x.model_name}</code> <span className="sub">{x.endpoint_name}</span> <KindBadge kind={x.endpoint_kind} /> <EnvBadge env={x.platform_environment} />
                        {!x.available && <span className="badge warn" style={{ marginLeft: 4 }}>nicht mehr gelistet</span>}
                      </div>
                    ))}
                    {m.members.length === 0 && <span className="sub">keine – wird nicht getestet</span>}
                  </td>
                  <td className="sub">
                    {[m.provider, m.license, m.open_weights === true ? 'Open Weights' : m.open_weights === false ? 'proprietär' : null, m.quantization, m.revision ? `Rev. ${m.revision}` : null].filter(Boolean).join(' · ') || '–'}
                  </td>
                  <td className="sub">{m.maintainer_name ?? '–'}</td>
                  <td>
                    <VisibilityBadge visibility={m.visibility} teamNames={m.teamIds.map(teamName)} />
                  </td>
                  <td className="num">
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {m.can_edit && (
                        <button className="btn sm ghost" onClick={() => setEditing(m)} aria-label={`${m.name} bearbeiten`}>
                          <Pencil size={14} />
                        </button>
                      )}
                      {manager && (
                        <button className="btn sm ghost danger" onClick={() => remove(m)} aria-label={`${m.name} entfernen`}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {portfolio.data && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    Noch keine Modelle im Portfolio. Lege Endpoints an und wähle über „Neues Modell“ die gefundenen Modelle aus.
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
            portfolio.reload();
            models.reload();
          }}
        />
      )}
    </>
  );
}

const CAPS = [
  ['vision', 'Vision'],
  ['tools', 'Tool-Calling'],
  ['reasoning', 'Reasoning'],
  ['json', 'JSON-Modus'],
];

const memberKey = (m) => `${m.endpoint_id}|${m.model_name}`;

function ModelEditor({ model, teams, onClose, onSaved }) {
  const users = useUserDirectory();
  const candidates = useApi('/api/portfolio/candidates');
  const [form, setForm] = useState({
    name: model.name ?? '',
    description: model.description ?? '',
    maintainer_id: model.maintainer_id ?? '',
    visibility: model.visibility ?? 'global',
    license: model.license ?? '',
    provider: model.provider ?? '',
    origin: model.origin ?? '',
    open_weights: model.open_weights === null || model.open_weights === undefined ? '' : String(model.open_weights),
    revision: model.revision ?? '',
    quantization: model.quantization ?? '',
    context_length: model.context_length ?? '',
  });
  const [capabilities, setCapabilities] = useState(model.capabilities ?? []);
  const [teamIds, setTeamIds] = useState(model.teamIds ?? []);
  const [selected, setSelected] = useState(() => new Set((model.members ?? []).map(memberKey)));
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const options = useMemo(() => {
    const own = (model.members ?? []).map((m) => ({ ...m, current: true }));
    return [...own, ...(candidates.data ?? [])].filter((m) => `${m.model_name} ${m.endpoint_name} ${m.platform_name}`.toLowerCase().includes(filter.toLowerCase()));
  }, [model, candidates.data, filter]);
  const toggle = (m) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(memberKey(m)) ? next.delete(memberKey(m)) : next.add(memberKey(m));
      return next;
    });

  async function save() {
    try {
      const all = [...(model.members ?? []), ...(candidates.data ?? [])];
      await api(model.id ? `/api/portfolio/${model.id}` : '/api/portfolio', {
        method: model.id ? 'PUT' : 'POST',
        body: {
          ...form,
          open_weights: form.open_weights === '' ? null : form.open_weights === 'true',
          context_length: form.context_length === '' ? null : Number(form.context_length),
          capabilities,
          maintainer_id: form.maintainer_id || null,
          teamIds,
          members: all.filter((m) => selected.has(memberKey(m))).map((m) => ({ endpoint_id: m.endpoint_id, model_name: m.model_name })),
        },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={model.id ? `Modell ${model.name}` : 'Neues Modell im Portfolio'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save} disabled={!form.name.trim() || (!model.id && selected.size === 0)}>
            Speichern
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      <label className="field">
        <span>Name</span>
        <input value={form.name} placeholder="z. B. Gemma4-31B" onChange={(e) => set({ name: e.target.value })} />
        <div className="hint">Dieser Name gilt in Prüfungen, Ergebnissen und im Dashboard.</div>
      </label>
      <div className="field">
        <span>Verwendete Modelle (gefunden an den Endpoints)</span>
        <input type="search" placeholder="Filtern…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
        <div className="pick-list" style={{ maxHeight: 220 }}>
          {options.map((m) => (
            <label key={memberKey(m)}>
              <input type="checkbox" checked={selected.has(memberKey(m))} onChange={() => toggle(m)} />
              <span>
                <code>{m.model_name}</code>
                <span className="sub">
                  {' '}
                  {m.endpoint_name} · {m.platform_name}
                </span>
              </span>
            </label>
          ))}
          {candidates.data && options.length === 0 && <div className="hint">Keine gefundenen Modelle. Frage die Modelle der Endpoints unter Plattformen › Inventar ab.</div>}
        </div>
        <div className="hint">{selected.size} ausgewählt. Bereits anderen Portfolio-Modellen zugeordnete Modelle erscheinen hier nicht.</div>
      </div>
      <label className="field">
        <span>Beschreibung</span>
        <input value={form.description} onChange={(e) => set({ description: e.target.value })} />
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
      {form.visibility === 'teams' && <TeamPicker teams={teams} value={teamIds} onChange={setTeamIds} />}
      <h3 style={{ margin: '16px 0 4px', fontSize: 14 }}>Metadaten</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        Grundlage für die Souveränitätseinstufung und die Eignung. Fähigkeiten bestimmen, welche Vorlagen für das Modell gelten (z. B. OCR nur mit Vision).
      </div>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        {CAPS.map(([key, label]) => (
          <label key={key} className="checkbox">
            <input type="checkbox" checked={capabilities.includes(key)} onChange={(e) => setCapabilities(e.target.checked ? [...capabilities, key] : capabilities.filter((c) => c !== key))} />
            {label}
          </label>
        ))}
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Lizenz</span>
          <input value={form.license} placeholder="Apache-2.0" onChange={(e) => set({ license: e.target.value })} />
        </label>
        <label className="field">
          <span>Anbieter</span>
          <input value={form.provider} placeholder="Alibaba" onChange={(e) => set({ provider: e.target.value })} />
        </label>
        <label className="field">
          <span>Herkunft (Ländercode)</span>
          <input value={form.origin} placeholder="DE" onChange={(e) => set({ origin: e.target.value })} />
        </label>
        <label className="field">
          <span>Open Weights</span>
          <select value={form.open_weights} onChange={(e) => set({ open_weights: e.target.value })}>
            <option value="">unbekannt</option>
            <option value="true">ja</option>
            <option value="false">nein</option>
          </select>
        </label>
        <label className="field">
          <span>Revision</span>
          <input value={form.revision} onChange={(e) => set({ revision: e.target.value })} />
        </label>
        <label className="field">
          <span>Quantisierung</span>
          <input value={form.quantization} placeholder="FP8" onChange={(e) => set({ quantization: e.target.value })} />
        </label>
        <label className="field">
          <span>Kontextlänge</span>
          <input type="number" value={form.context_length} onChange={(e) => set({ context_length: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}
