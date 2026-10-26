import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Plus, Trash2, Upload } from 'lucide-react';
import { api, can, Card, Empty, ErrorBox, Field, fmt, Loading, Modal, PageHead, useAction, useApi, useUser } from '../lib.jsx';

export const SENSITIVITY_LABELS = { public: 'Öffentlich', internal: 'Intern', customer: 'Kundendaten', attack: 'Angriff' };

const readText = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`${file.name} nicht lesbar`));
    r.readAsText(file);
  });
const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, base64: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(new Error(`${file.name} nicht lesbar`));
    r.readAsDataURL(file);
  });

export function Datasets() {
  const user = useUser();
  const list = useApi('/api/datasets');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead
        title="Datensätze"
        action={
          can(user, 'tests.manage') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Neuer Datensatz
            </button>
          )
        }
      >
        Datensätze sind versionierte Fälle, Dokumente und Bilder mit Hash, Sprache und Sensitivität. Vorlagen verweisen auf eine feste Version, damit Läufe reproduzierbar bleiben.
      </PageHead>
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Noch keine Datensätze.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Art</th>
                    <th>Sprache</th>
                    <th>Sensitivität</th>
                    <th>Version</th>
                    <th>Fälle</th>
                    <th>Genutzt von</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link className="title-link" to={`/datasets/${d.id}`}>
                          {d.name}
                        </Link>{' '}
                        {d.official && <span className="tag">offiziell</span>}
                        <div className="sub mono">{d.key}</div>
                      </td>
                      <td>{d.kind}</td>
                      <td>{d.language}</td>
                      <td>
                        <span className={`badge ${d.sensitivity === 'attack' ? 'failed' : ''}`}>{SENSITIVITY_LABELS[d.sensitivity]}</span>
                      </td>
                      <td className="mono">{d.latest_version}</td>
                      <td>
                        {d.case_count}
                        {!d.sufficient && (
                          <span className="badge warn" style={{ marginLeft: 6 }} title={`Mindestens ${d.min_cases} Fälle für belastbare Aussagen`}>
                            zu klein
                          </span>
                        )}
                      </td>
                      <td>{d.template_versions} Vorlagenversionen</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
      {creating && <DatasetForm onClose={() => setCreating(false)} onSaved={() => (setCreating(false), list.reload())} />}
    </>
  );
}

// Neuer Datensatz oder neue Version (dataset gesetzt). Fälle als CSV, JSONL oder JSON-Liste, Anhänge als Dateien.
function DatasetForm({ dataset, onClose, onSaved }) {
  const kinds = useApi('/api/dataset-kinds');
  const [form, setForm] = useState({
    name: '',
    description: '',
    kind: dataset?.kind ?? 'qa',
    language: dataset?.language ?? 'de',
    sensitivity: dataset?.sensitivity ?? 'internal',
    min_cases: dataset?.min_cases ?? 30,
    bump: 'minor',
    notes: '',
  });
  const [payload, setPayload] = useState(null);
  const [files, setFiles] = useState([]);
  const [check, setCheck] = useState(null);
  const [run, error, busy, setError] = useAction();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const kind = kinds.data?.find((k) => k.key === form.kind);

  async function pickCases(file) {
    if (!file) return;
    setCheck(null);
    const text = await readText(file);
    if (/\.csv$/i.test(file.name)) setPayload({ name: file.name, csv: text });
    else if (/\.jsonl$/i.test(file.name)) setPayload({ name: file.name, jsonl: text });
    else {
      try {
        const parsed = JSON.parse(text);
        setPayload({ name: file.name, cases: Array.isArray(parsed) ? parsed : (parsed.cases ?? []) });
      } catch {
        setError('Datei ist kein gültiges JSON');
      }
    }
  }
  const pickFiles = (list) => run(async () => setFiles([...files, ...(await Promise.all([...list].map(readBase64)))]));
  const body = () => {
    const { name: _n, ...cases } = payload ?? {};
    return { ...form, ...cases, files };
  };
  const validate = () =>
    run(async () => {
      setCheck(await api('/api/datasets/validate', { method: 'POST', body: body() }));
    });
  const save = () =>
    run(async () => {
      await api(dataset ? `/api/datasets/${dataset.id}/versions` : '/api/datasets', { method: 'POST', body: body() });
      onSaved();
    });

  return (
    <Modal
      title={dataset ? `Neue Version von ${dataset.name}` : 'Neuer Datensatz'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={validate} disabled={!payload || busy}>
            <CheckCircle2 size={14} /> Prüfen
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save} disabled={!payload || busy || (!dataset && !form.name.trim())}>
            Speichern
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {!dataset && (
        <>
          <Field label="Name">
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Beschreibung">
            <input value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Art">
              <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
                {(kinds.data ?? []).map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sprache">
              <input value={form.language} onChange={(e) => set({ language: e.target.value })} />
            </Field>
            <Field label="Sensitivität" hint="Angriffs-Datensätze sehen nur Personen mit der Berechtigung security.payloads.">
              <select value={form.sensitivity} onChange={(e) => set({ sensitivity: e.target.value })}>
                {Object.entries(SENSITIVITY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Mindestzahl Fälle" hint="Darunter wird der Datensatz als zu klein markiert.">
              <input type="number" min={1} value={form.min_cases} onChange={(e) => set({ min_cases: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      {dataset && (
        <div className="form-grid">
          <Field label="Versionssprung">
            <select value={form.bump} onChange={(e) => set({ bump: e.target.value })}>
              <option value="patch">Patch (Korrekturen)</option>
              <option value="minor">Minor (neue Fälle)</option>
              <option value="major">Major (neues Schema)</option>
            </select>
          </Field>
          <Field label="Änderungsnotiz">
            <input value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
      )}
      <Field
        label="Fälle (CSV, JSONL oder JSON)"
        hint={kind ? `Pflichtfelder für „${kind.label}“: ${kind.required.join(', ') || 'keine'}. Optional: key, difficulty, category.` : undefined}
      >
        <input type="file" accept=".csv,.jsonl,.json" onChange={(e) => pickCases(e.target.files[0])} />
      </Field>
      <Field label="Anhänge (Bilder, PDF) – Dateinamen werden in den Fällen referenziert">
        <input type="file" multiple onChange={(e) => pickFiles(e.target.files)} />
      </Field>
      {files.length > 0 && (
        <div className="tags">
          {files.map((f) => (
            <span key={f.name} className="tag">
              {f.name}{' '}
              <button className="btn ghost sm" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label="Entfernen">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {check && (
        <div className={check.ok ? 'hint' : 'error-box'} style={{ marginTop: 12 }}>
          {check.ok ? `Gültig: ${check.cases} Fälle, ${check.files} Dateien.` : `${check.errors.length} Fehler:`}
          {check.errors.map((e, i) => (
            <div key={i}>
              Zeile {e.row}: {e.message}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function DatasetDetail() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const dataset = useApi(`/api/datasets/${id}`);
  const [version, setVersion] = useState(null);
  const current = version ?? dataset.data?.versions?.[0]?.version;
  const detail = useApi(current ? `/api/datasets/${id}/versions/${current}` : null);
  const [adding, setAdding] = useState(false);
  const [run, error] = useAction();
  const editable = can(user, 'tests.manage') && dataset.data && !dataset.data.official;
  const remove = () =>
    confirm('Datensatz löschen?') &&
    run(async () => {
      await api(`/api/datasets/${id}`, { method: 'DELETE' });
      navigate('/datasets');
    });
  return (
    <Loading state={dataset}>
      {(d) => (
        <>
          <PageHead
            title={d.name}
            action={
              editable && (
                <div className="btn-row">
                  <button className="btn" onClick={() => setAdding(true)}>
                    <Upload size={15} /> Neue Version
                  </button>
                  <button className="btn ghost danger" onClick={remove} aria-label="Löschen">
                    <Trash2 size={15} />
                  </button>
                </div>
              )
            }
          >
            {d.description ?? `${d.kind} · ${d.language} · ${SENSITIVITY_LABELS[d.sensitivity]}`}
          </PageHead>
          <ErrorBox error={error} />
          <div className="two-col">
            <Card title="Versionen" flush>
              <table>
                <tbody>
                  {d.versions.map((v) => (
                    <tr key={v.id} onClick={() => setVersion(v.version)} style={{ cursor: 'pointer', fontWeight: v.version === current ? 600 : 400 }}>
                      <td className="mono">{v.version}</td>
                      <td>{v.case_count} Fälle</td>
                      <td className="sub">{fmt.date(v.created_at)}</td>
                      <td className="sub">{v.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title={`Version ${current ?? ''}`} sub={detail.data ? `Hash ${detail.data.hash.slice(0, 16)}…` : undefined}>
              {detail.data?.hidden && <div className="hint">Inhalte dieses Angriffs-Datensatzes sind ohne die Berechtigung security.payloads verborgen. Namen und Schwierigkeit bleiben sichtbar.</div>}
              {detail.data && !detail.data.sufficient && <div className="hint">Weniger als {detail.data.min_cases} Fälle: Aussagen daraus sind statistisch schwach.</div>}
              {detail.data?.files.length > 0 && (
                <div className="tags" style={{ margin: '8px 0' }}>
                  {detail.data.files.map((f) => (
                    <a key={f.name} className="tag" href={`/api/datasets/${id}/versions/${current}/files/${encodeURIComponent(f.name)}`} target="_blank" rel="noreferrer">
                      {f.name}
                    </a>
                  ))}
                </div>
              )}
            </Card>
          </div>
          <Card title="Fälle" flush>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Schlüssel</th>
                    <th>Schwierigkeit</th>
                    <th>Kategorie</th>
                    <th>Inhalt</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.data?.cases ?? []).slice(0, 200).map((c) => (
                    <tr key={c.position}>
                      <td className="mono">{c.case_key}</td>
                      <td>{c.difficulty ?? '–'}</td>
                      <td>{c.category ?? '–'}</td>
                      <td className="sub mono" style={{ maxWidth: 520, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {c.data ? JSON.stringify(c.data).slice(0, 300) : 'verborgen'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {adding && <DatasetForm dataset={d} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), setVersion(null), dataset.reload())} />}
        </>
      )}
    </Loading>
  );
}
