import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api, can, fmt, JsonField, Modal, StatusBadge, TYPE_LABELS, useApi, useUser } from '../lib.jsx';

export default function Tests() {
  const user = useUser();
  const navigate = useNavigate();
  const tests = useApi('/api/tests');
  const types = useApi('/api/test-types');
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const isTester = can(user, 'tester');

  const grouped = useMemo(() => {
    const map = new Map();
    for (const t of tests.data ?? []) {
      if (!map.has(t.type)) map.set(t.type, []);
      map.get(t.type).push(t);
    }
    return map;
  }, [tests.data]);

  async function run(body) {
    setError(null);
    try {
      const r = await api('/api/runs', { method: 'POST', body });
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setError(e.message);
    }
  }

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function remove(t) {
    if (!confirm(`Test "${t.name}" löschen? Bisherige Ergebnisse bleiben erhalten.`)) return;
    await api(`/api/tests/${t.id}`, { method: 'DELETE' });
    tests.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tests</h1>
          <p>Einzeln starten, mehrere auswählen und gebündelt ausführen oder alle Tests auf einmal laufen lassen.</p>
        </div>
        {isTester && (
          <div className="btn-row">
            <button className="btn" disabled={!selected.size} onClick={() => run({ kind: 'selection', testIds: [...selected] })}>
              <Play size={15} /> Auswahl ausführen ({selected.size})
            </button>
            <button className="btn" onClick={() => run({ kind: 'all' })}>
              <Play size={15} /> Alle ausführen
            </button>
            <button className="btn primary" onClick={() => setEditing({})}>
              <Plus size={15} /> Neuer Test
            </button>
          </div>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}

      {tests.data && tests.data.length === 0 && (
        <div className="card empty">Noch keine Tests angelegt. Lege zuerst im Admin-Bereich einen Endpoint an und dann hier einen Test.</div>
      )}

      {[...grouped.entries()].map(([type, list]) => {
        const info = types.data?.find((t) => t.type === type);
        return (
          <section className="type-group" key={type}>
            <div className="type-head">
              <h2>{TYPE_LABELS[type] ?? type}</h2>
              <p>{info?.description}</p>
            </div>
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    {isTester && <th style={{ width: 36 }} />}
                    <th>Name</th>
                    <th>Endpoint</th>
                    <th>Persona</th>
                    <th>Letztes Ergebnis</th>
                    <th className="num">Score</th>
                    <th className="num">Zuletzt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <tr key={t.id}>
                      {isTester && (
                        <td>
                          <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`${t.name} auswählen`} />
                        </td>
                      )}
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.name}</div>
                        {!t.enabled && <span className="badge warn">deaktiviert</span>}
                        {t.tags?.map((tag) => (
                          <span className="tag" key={tag} style={{ marginRight: 4 }}>
                            {tag}
                          </span>
                        ))}
                      </td>
                      <td>{t.endpoint_name ?? '–'}</td>
                      <td>{t.persona_name ?? <span className="sub">Endpoint-Key</span>}</td>
                      <td>{t.last_status ? <StatusBadge status={t.last_status} /> : <span className="sub">noch nie</span>}</td>
                      <td className="num">{fmt.pct(t.last_score)}</td>
                      <td className="num sub">{fmt.ago(t.last_run_at)}</td>
                      <td className="num">
                        {isTester && (
                          <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            <button className="btn sm" disabled={!t.enabled} onClick={() => run({ kind: 'single', testIds: [t.id] })}>
                              <Play size={13} /> Starten
                            </button>
                            <button className="btn sm ghost" onClick={() => setEditing(t)} aria-label="Bearbeiten">
                              <Pencil size={14} />
                            </button>
                            <button className="btn sm ghost danger" onClick={() => remove(t)} aria-label="Löschen">
                              <Trash2 size={14} />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {editing && (
        <TestEditor
          test={editing}
          types={types.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            tests.reload();
          }}
        />
      )}
    </>
  );
}

function TestEditor({ test, types, onClose, onSaved }) {
  const endpoints = useApi('/api/endpoints');
  const personas = useApi('/api/personas');
  const [form, setForm] = useState({
    name: test.name ?? '',
    type: test.type ?? types[0]?.type ?? 'smoke',
    endpoint_id: test.endpoint_id ?? '',
    persona_id: test.persona_id ?? '',
    tags: (test.tags ?? []).join(', '),
    enabled: test.enabled ?? true,
  });
  const typeInfo = types.find((t) => t.type === form.type);
  // Neuer Test: Standardkonfiguration des Typs vorbefüllen; beim Typwechsel neu befüllen.
  const [config, setConfig] = useState(() => (test.id ? test.config : typeInfo?.defaults ?? {}));
  const [configKey, setConfigKey] = useState(0);
  const [configValid, setConfigValid] = useState(true);
  const [error, setError] = useState(null);

  function changeType(type) {
    setForm((f) => ({ ...f, type }));
    setConfig(types.find((t) => t.type === type)?.defaults ?? {});
    setConfigKey((k) => k + 1);
  }

  const allowedEndpoints = (endpoints.data ?? []).filter((e) => !typeInfo || typeInfo.endpointKinds.includes(e.kind));
  const selectedEndpoint = endpoints.data?.find((e) => e.id === form.endpoint_id);
  const modelNames = [...new Set((selectedEndpoint?.models ?? []).filter((m) => m.available).map((m) => m.alias ?? m.name))];

  async function save() {
    setError(null);
    const body = {
      ...form,
      config,
      tags: form.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      await api(test.id ? `/api/tests/${test.id}` : '/api/tests', { method: test.id ? 'PUT' : 'POST', body });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={test.id ? 'Test bearbeiten' : 'Neuer Test'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!configValid} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Testart</span>
          <select value={form.type} onChange={(e) => changeType(e.target.value)} disabled={Boolean(test.id)}>
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Endpoint</span>
          <select value={form.endpoint_id} onChange={(e) => setForm({ ...form, endpoint_id: e.target.value })}>
            <option value="">Bitte wählen…</option>
            {allowedEndpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.kind})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Ausführen als Persona</span>
          <select value={form.persona_id ?? ''} onChange={(e) => setForm({ ...form, persona_id: e.target.value })}>
            <option value="">Key des Endpoints</option>
            {(personas.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Tags</span>
          <input value={form.tags} placeholder="nightly, gateway" onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        </label>
        <label className="field">
          <span>Status</span>
          <span className="checkbox">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> aktiv
          </span>
        </label>
      </div>
      {typeInfo && <p className="hint" style={{ marginTop: -4 }}>{typeInfo.description}</p>}
      {modelNames.length > 0 && (
        <p className="hint">
          Verfügbare Modelle an diesem Endpoint (Alias oder Name verwendbar): <code>{modelNames.join(', ')}</code>
        </p>
      )}
      <JsonField
        key={configKey}
        label="Konfiguration (JSON)"
        value={config}
        rows={16}
        hint="Persona-Namen in Fällen (z. B. access, mcp) beziehen sich auf die Test-Personas aus dem Admin-Bereich. Optional: timeoutS, regressionTolerance, failOnRegression."
        onChange={(value, valid) => {
          setConfigValid(valid);
          if (valid) setConfig(value);
        }}
      />
    </Modal>
  );
}
