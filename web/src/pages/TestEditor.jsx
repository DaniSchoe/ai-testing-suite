import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Info, Play, Repeat, Save, Zap } from 'lucide-react';
import { api, Card, CRON_PRESETS, JsonField, KindBadge, TYPE_LABELS, useApi, useUser, useUserDirectory } from '../lib.jsx';
import { TYPE_DOCS, typeIcon } from '../testTypeDocs.js';

const MODES = [
  ['save', 'Nur speichern', Save, 'Du startest den Test später selbst.'],
  ['now', 'Jetzt ausführen', Zap, 'Einmalig, direkt nach dem Speichern.'],
  ['once', 'Geplant', CalendarClock, 'Einmalig zu einem festen Zeitpunkt.'],
  ['recurring', 'Regelmäßig', Repeat, 'Wiederholt nach Zeitplan (Cron).'],
];

// Lokale Eingabe (datetime-local) <-> ISO
const toLocalInput = (iso) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function TagInput({ value, onChange }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText('');
  };
  return (
    <div className="chip-input">
      {value.map((t) => (
        <span key={t} className="tag">
          {t}{' '}
          <button type="button" className="btn ghost sm" style={{ padding: 0 }} aria-label={`${t} entfernen`} onClick={() => onChange(value.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        placeholder={value.length ? '' : 'Tag eingeben, Enter drücken'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

export default function TestEditor() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const existing = useApi(id ? `/api/builds/${id}` : null);
  const types = useApi('/api/test-types');
  const endpoints = useApi('/api/endpoints');
  const keys = useApi('/api/api-keys');
  const users = useUserDirectory();

  const [form, setForm] = useState(null);
  const [expert, setExpert] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState([]);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Formular initialisieren: neuer Test oder vorhandener Test.
  useEffect(() => {
    if (form) return;
    if (!id) {
      setForm({
        name: '',
        description: '',
        tags: [],
        maintainer_id: user.id,
        endpoint_id: '',
        models: [],
        api_key_id: '',
        types: [],
        configs: {},
        mode: 'save',
        run_at: toLocalInput(),
        cron: '0 3 * * *',
        timezone: 'Europe/Berlin',
      });
    } else if (existing.data) {
      const b = existing.data;
      setForm({
        name: b.name,
        description: b.description ?? '',
        tags: b.tags ?? [],
        maintainer_id: b.maintainer_id ?? '',
        endpoint_id: b.endpoint_id ?? '',
        models: b.models ?? [],
        api_key_id: b.api_key_id ?? '',
        types: b.types,
        configs: b.configs ?? {},
        mode: b.schedule_id && b.schedule_enabled ? (b.schedule_run_at ? 'once' : 'recurring') : 'save',
        run_at: toLocalInput(b.schedule_run_at),
        cron: b.schedule_cron ?? '0 3 * * *',
        timezone: b.schedule_timezone ?? 'Europe/Berlin',
      });
    }
  }, [id, existing.data, form, user.id]);

  const endpoint = endpoints.data?.find((e) => e.id === form?.endpoint_id);
  const modelOptions = useMemo(() => {
    const names = new Map();
    for (const m of endpoint?.models ?? []) if (m.available) names.set(m.alias ?? m.name, m);
    for (const m of form?.models ?? []) if (!names.has(m)) names.set(m, { name: m, missing: true });
    return [...names.keys()];
  }, [endpoint, form?.models]);
  const compatible = (t) => !endpoint || t.endpointKinds.includes(endpoint.kind);
  const typeList = types.data ?? [];

  function toggleType(t) {
    const has = form.types.includes(t.type);
    const configs = { ...form.configs };
    if (!has && !configs[t.type]) {
      const { model, ...rest } = t.defaults ?? {};
      configs[t.type] = rest;
    }
    set({ types: has ? form.types.filter((x) => x !== t.type) : [...form.types, t.type], configs });
  }

  function toggleModel(name) {
    set({ models: form.models.includes(name) ? form.models.filter((m) => m !== name) : [...form.models, name] });
  }

  function changeEndpoint(endpointId) {
    const next = endpoints.data.find((e) => e.id === endpointId);
    // Testarten, die nicht zur neuen Endpoint-Art passen, entfallen; Modelle des alten Endpoints ebenfalls.
    const types = form.types.filter((t) => !next || typeList.find((x) => x.type === t)?.endpointKinds.includes(next.kind));
    set({ endpoint_id: endpointId, types, models: [] });
  }

  const body = form && {
    name: form.name,
    description: form.description,
    tags: form.tags,
    maintainer_id: form.maintainer_id || null,
    endpoint_id: form.endpoint_id,
    models: form.models,
    api_key_id: form.api_key_id || null,
    types: form.types,
    configs: Object.fromEntries(form.types.map((t) => [t, form.configs[t] ?? {}])),
    schedule: { mode: form.mode, run_at: form.mode === 'once' ? new Date(form.run_at).toISOString() : undefined, cron: form.cron, timezone: form.timezone },
  };

  // Vorschau: welche Einzeltests entstehen?
  const previewKey = form && JSON.stringify([form.name, form.endpoint_id, form.types, form.models, form.configs]);
  useEffect(() => {
    if (!form || !form.endpoint_id || form.types.length === 0) {
      setPreview([]);
      return undefined;
    }
    const t = setTimeout(() => {
      api('/api/builds/preview', { method: 'POST', body }).then(setPreview).catch(() => setPreview([]));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await api(id ? `/api/builds/${id}` : '/api/builds', { method: id ? 'PUT' : 'POST', body });
      navigate(res.run ? `/runs/${res.run.id}` : '/test-builder');
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  if (!form) return null;
  const canSchedule = user.permissions.includes('schedules.manage') || user.is_admin;
  const canRun = user.permissions.includes('runs.start') || user.is_admin;
  const modes = MODES.filter(([m]) => (m === 'now' ? canRun : m === 'once' || m === 'recurring' ? canSchedule : true));
  const saveLabel = { save: 'Speichern', now: 'Speichern und ausführen', once: 'Speichern und planen', recurring: 'Speichern und planen' }[form.mode];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{id ? 'Test bearbeiten' : 'Neuer Test'}</h1>
          <p>Wähle Endpoint, Modelle und Testarten, lege fest, wann der Test läuft, und speichere ihn.</p>
        </div>
        <Link className="btn" to="/test-builder">
          <ArrowLeft size={15} /> Zurück
        </Link>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="builder">
        <div className="builder-main">
          <Card title="1 · Allgemein">
            <label className="field">
              <span>Name</span>
              <input value={form.name} placeholder="z. B. Nightly Gateway" onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field">
              <span>Beschreibung</span>
              <textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>Tags</span>
                <TagInput value={form.tags} onChange={(tags) => set({ tags })} />
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
            </div>
          </Card>

          <Card title="2 · Ziel" sub="Endpoint, Modelle und API-Key, mit dem der Test läuft">
            <div className="form-grid">
              <label className="field">
                <span>Endpoint</span>
                <select value={form.endpoint_id} onChange={(e) => changeEndpoint(e.target.value)}>
                  <option value="">Bitte wählen…</option>
                  {(endpoints.data ?? [])
                    .filter((e) => e.enabled)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
                {endpoint && (
                  <div className="hint">
                    <KindBadge kind={endpoint.kind} flavor={endpoint.llm_flavor} />
                  </div>
                )}
              </label>
              <label className="field">
                <span>API-Key</span>
                <select value={form.api_key_id} onChange={(e) => set({ api_key_id: e.target.value })}>
                  <option value="">Key des Endpoints</option>
                  {(keys.data ?? []).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {endpoint && endpoint.kind !== 'mcp' && (
              <>
                <label className="field" style={{ marginBottom: 6 }}>
                  <span>
                    Modelle ({form.models.length || 'Standardmodell'}){' '}
                    {form.models.length > 0 && (
                      <button type="button" className="btn ghost sm" onClick={() => set({ models: [] })}>
                        Auswahl leeren
                      </button>
                    )}
                  </span>
                </label>
                <div className="pick-list" style={{ maxHeight: 190 }}>
                  {modelOptions.map((m) => (
                    <label key={m}>
                      <input type="checkbox" checked={form.models.includes(m)} onChange={() => toggleModel(m)} />
                      <span style={{ fontWeight: 600 }}>{m}</span>
                    </label>
                  ))}
                  {modelOptions.length === 0 && <div className="empty">Keine Modelle am Endpoint gefunden</div>}
                </div>
                <div className="hint">Mehrfachauswahl möglich. Ohne Auswahl läuft der Test mit dem Standardmodell des Endpoints.</div>
              </>
            )}
          </Card>

          <Card title="3 · Testarten" sub="Beliebig kombinierbar: alles, was du ankreuzt, läuft gebündelt">
            <div className="type-grid">
              {typeList.map((t) => {
                const Icon = typeIcon(t.type);
                const ok = compatible(t);
                const checked = form.types.includes(t.type);
                return (
                  <label key={t.type} className={`type-card${checked ? ' checked' : ''}${ok ? '' : ' disabled'}`} title={ok ? '' : 'Passt nicht zur Art des gewählten Endpoints'}>
                    <input type="checkbox" checked={checked} disabled={!ok} onChange={() => toggleType(t)} />
                    <span className="icon-chip">
                      <Icon size={16} />
                    </span>
                    <span>
                      <div className="title">{TYPE_LABELS[t.type] ?? t.label}</div>
                      <div className="desc">{TYPE_DOCS[t.type]?.summary ?? t.description}</div>
                      <Link to={`/test-types/${t.type}`} target="_blank" onClick={(e) => e.stopPropagation()}>
                        <Info size={12} style={{ verticalAlign: -1 }} /> Was wird getestet?
                      </Link>
                    </span>
                  </label>
                );
              })}
            </div>
            <label className="checkbox" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} /> Experten-Modus: Konfiguration als JSON bearbeiten
            </label>
            {expert &&
              form.types.map((t) => (
                <JsonField
                  key={t}
                  label={`Konfiguration ${TYPE_LABELS[t] ?? t}`}
                  value={form.configs[t] ?? {}}
                  rows={12}
                  hint="Das Modell kommt aus der Modellauswahl. Optional: timeoutS, regressionTolerance, failOnRegression."
                  onChange={(v, ok) => ok && set({ configs: { ...form.configs, [t]: v } })}
                />
              ))}
          </Card>

          <Card title="4 · Ausführung">
            <div className="mode-grid">
              {modes.map(([m, label, Icon, text]) => (
                <label key={m} className={`type-card${form.mode === m ? ' checked' : ''}`}>
                  <input type="radio" name="mode" checked={form.mode === m} onChange={() => set({ mode: m })} />
                  <span>
                    <div className="title">
                      <Icon size={14} style={{ verticalAlign: -2 }} /> {label}
                    </div>
                    <div className="desc">{text}</div>
                  </span>
                </label>
              ))}
            </div>
            {form.mode === 'once' && (
              <label className="field">
                <span>Zeitpunkt</span>
                <input type="datetime-local" value={form.run_at} onChange={(e) => set({ run_at: e.target.value })} />
              </label>
            )}
            {form.mode === 'recurring' && (
              <div className="form-grid">
                <label className="field">
                  <span>Cron-Ausdruck</span>
                  <input value={form.cron} onChange={(e) => set({ cron: e.target.value })} />
                  <div className="hint">
                    {CRON_PRESETS.map(([c, l]) => (
                      <button key={c} type="button" className="btn sm ghost" style={{ padding: '2px 6px' }} onClick={() => set({ cron: c })}>
                        {l}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="field">
                  <span>Zeitzone</span>
                  <input value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} />
                </label>
              </div>
            )}
          </Card>
        </div>

        <div className="builder-side">
          <Card title="Zusammenfassung">
            {preview.length === 0 ? (
              <div className="sub">Wähle Endpoint und mindestens eine Testart.</div>
            ) : (
              <>
                <div className="sub" style={{ marginBottom: 8 }}>
                  Beim Ausführen entstehen {preview.length} Einzeltests:
                </div>
                <ul className="steps" style={{ fontSize: 13 }}>
                  {preview.map((p) => (
                    <li key={p.name}>{p.name}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={save} disabled={saving}>
                {form.mode === 'now' ? <Play size={14} /> : <Save size={14} />} {saveLabel}
              </button>
              <Link className="btn" to="/test-builder">
                Abbrechen
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
