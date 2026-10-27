import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Download, FlaskConical, Play, Plus, Send, Trash2, Upload, X } from 'lucide-react';
import {
  api,
  can,
  Card,
  download,
  Empty,
  ErrorBox,
  Field,
  fmt,
  getPlatform,
  JsonField,
  LifecycleBadge,
  Loading,
  Modal,
  PageHead,
  pctText,
  Tabs,
  TYPE_LABELS,
  TypeIcon,
  useAction,
  useApi,
  useTeams,
  useUser,
} from '../lib.jsx';

const ORIGIN_LABELS = { official: 'Offiziell', team: 'Team', private: 'Privat' };
const USE_CASE_LABELS = { chat: 'Chat', coding: 'Coding', ocr: 'OCR', agent: 'Agent' };
const REQUIRES = [
  ['vision', 'Vision'],
  ['tools', 'Tool-Calling'],
  ['reasoning', 'Reasoning'],
  ['mcp', 'MCP'],
  ['json', 'JSON-Modus'],
];
const METRIC_HINTS = ['score', 'error_rate', 'latency_ms_p95', 'ttft_ms_p95', 'tokens_per_s_avg', 'false_allow', 'leak_rate'];
const OPS = ['>=', '>', '<=', '<', '=='];
const TARGET_LABELS = { platform: 'Plattform', llm: 'LLM', data: 'Daten', process: 'Prozesse' };
const DEFAULT_TARGET = { smoke: 'platform', load: 'platform', access: 'platform', mcp: 'platform', network: 'platform' };

const OriginBadge = ({ origin }) => <span className={`tag ${origin === 'official' ? 'official' : ''}`}>{ORIGIN_LABELS[origin] ?? origin}</span>;

export function Catalog() {
  const user = useUser();
  const [filters, setFilters] = useState({ q: '', type: '', target: '', origin: '', use_case: '', status: '' });
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const templates = useApi(`/api/catalog/templates?${query}`);
  const [creating, setCreating] = useState(null);
  const editor = can(user, 'tests.manage');
  const navigate = useNavigate();
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      <PageHead
        title="Vorlagen"
        action={
          editor && (
            <div className="btn-row">
              <button className="btn" onClick={() => setCreating('import')}>
                <Upload size={15} /> Importieren
              </button>
              <button className="btn primary" onClick={() => setCreating('template')}>
                <Plus size={15} /> Neue Vorlage
              </button>
            </div>
          )
        }
      >
        Vorlagen beschreiben, was geprüft wird (Datensatz, Bewertung, Anforderungen) und worauf sich der Test richtet: Plattform, LLM, Daten oder Prozesse. Sie sind versioniert und durchlaufen Entwurf, Prüfung und Veröffentlichung.
      </PageHead>
      <div className="toolbar">
        <input type="search" placeholder="Suchen…" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        <select className="inline" value={filters.type} onChange={(e) => set({ type: e.target.value })} aria-label="Testart">
          <option value="">Alle Testarten</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="inline" value={filters.target} onChange={(e) => set({ target: e.target.value })} aria-label="Test-Ziel">
          <option value="">Alle Test-Ziele</option>
          {Object.entries(TARGET_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="inline" value={filters.use_case} onChange={(e) => set({ use_case: e.target.value })} aria-label="Einsatzprofil">
          <option value="">Alle Profile</option>
          {Object.entries(USE_CASE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="inline" value={filters.origin} onChange={(e) => set({ origin: e.target.value })} aria-label="Herkunft">
          <option value="">Alle Herkünfte</option>
          {Object.entries(ORIGIN_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="inline" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          <option value="">Alle Stände</option>
          <option value="published">Veröffentlicht</option>
          <option value="draft">Entwurf</option>
          <option value="review">In Prüfung</option>
          <option value="deprecated">Veraltet</option>
        </select>
      </div>
      <Loading state={templates}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Keine Vorlagen gefunden.</Empty>
          ) : (
            <div className="tile-grid">
              {rows.map((t) => (
                <Link key={t.id} className="tile" to={`/catalog/templates/${t.id}`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <span className="tile-icon" style={{ marginBottom: 0 }} title={TYPE_LABELS[t.type] ?? t.type}>
                      <TypeIcon type={t.type} size={18} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ margin: 0 }}>{t.name}</h3>
                      <div className="sub">{TYPE_LABELS[t.type] ?? t.type}</div>
                    </div>
                  </div>
                  <div className="sub" style={{ minHeight: 36 }}>
                    {t.description}
                  </div>
                  <div className="btn-row" style={{ marginTop: 8, gap: 6 }}>
                    <span className="mono">{t.latest.version}</span>
                    <LifecycleBadge status={t.latest.status} />
                    <span className="tag">{TARGET_LABELS[t.target] ?? t.target}</span>
                    <OriginBadge origin={t.origin} />
                  </div>
                </Link>
              ))}
            </div>
          )
        }
      </Loading>
      {creating === 'template' && <TemplateForm onClose={() => setCreating(null)} onSaved={(t) => navigate(`/catalog/templates/${t.id}`)} />}
      {creating === 'import' && <ImportDialog onClose={() => setCreating(null)} onDone={() => templates.reload()} />}
    </>
  );
}

// ----------------------------------------------------------------------------------------------------------------- Spezifikation

export function ThresholdRows({ value, onChange }) {
  const update = (i, patch) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {value.map((r, i) => (
        <div key={i} className="btn-row" style={{ marginBottom: 6 }}>
          <input list="metric-hints" value={r.metric} placeholder="Kennzahl" onChange={(e) => update(i, { metric: e.target.value })} />
          <select value={r.op} onChange={(e) => update(i, { op: e.target.value })}>
            {OPS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <input type="number" step="any" value={r.value} onChange={(e) => update(i, { value: Number(e.target.value) })} style={{ width: 110 }} />
          <button className="btn ghost sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Entfernen">
            <X size={14} />
          </button>
        </div>
      ))}
      <datalist id="metric-hints">
        {METRIC_HINTS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button className="btn sm" onClick={() => onChange([...value, { metric: 'score', op: '>=', value: 0.8 }])}>
        <Plus size={13} /> Schwellwert
      </button>
    </>
  );
}

// Strukturierte Felder der Spezifikation; alles Übrige (config, scoring, prompt …) als JSON.
function SpecEditor({ spec, onChange }) {
  const datasets = useApi('/api/datasets');
  const { dataset, requires = [], repeats, suggested_thresholds = [], ...rest } = spec;
  const emit = (patch) => onChange({ ...spec, ...patch });
  const current = datasets.data?.find((d) => d.key === dataset?.key);
  return (
    <>
      <div className="form-grid">
        <Field label="Datensatz" hint="Die Version wird festgehalten. Ohne Datensatz nutzt die Testart ihre eingebauten Fälle.">
          <select
            value={dataset?.key ?? ''}
            onChange={(e) => {
              const d = datasets.data?.find((x) => x.key === e.target.value);
              emit({ dataset: d ? { key: d.key, version: d.latest_version } : null });
            }}
          >
            <option value="">– keiner –</option>
            {(datasets.data ?? []).map((d) => (
              <option key={d.id} value={d.key}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Datensatzversion">
          <input disabled={!dataset} value={dataset?.version ?? ''} placeholder={current?.latest_version} onChange={(e) => emit({ dataset: { ...dataset, version: e.target.value } })} />
        </Field>
        <Field label="Wiederholungen (Vorschlag)">
          <input type="number" min={1} max={20} value={repeats ?? ''} onChange={(e) => emit({ repeats: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </div>
      <Field label="Voraussetzungen des Modells" hint="Fehlt eine Fähigkeit, gilt die Vorlage für das Modell als „nicht anwendbar“ statt als Fehler.">
        <div className="btn-row">
          {REQUIRES.map(([key, label]) => (
            <label key={key} className="checkbox">
              <input type="checkbox" checked={requires.includes(key)} onChange={(e) => emit({ requires: e.target.checked ? [...requires, key] : requires.filter((r) => r !== key) })} />
              {label}
            </label>
          ))}
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(spec.load)} onChange={(e) => emit({ load: e.target.checked })} />
            Lasttest (braucht Freigabe)
          </label>
        </div>
      </Field>
      <Field label="Vorgeschlagene Schwellwerte">
        <ThresholdRows value={suggested_thresholds} onChange={(v) => emit({ suggested_thresholds: v })} />
      </Field>
      <JsonField
        label="Weitere Einstellungen (config, params, scoring, prompt …)"
        value={rest}
        rows={12}
        onChange={(v, ok) => ok && onChange({ dataset, requires, repeats, suggested_thresholds, ...v })}
        hint="Gültiges JSON. Felder aus den obigen Eingaben werden nicht hier gepflegt."
      />
    </>
  );
}

function CategoryPicker({ value, onChange }) {
  const cats = useApi('/api/catalog/categories');
  const byFramework = useMemo(() => {
    const m = new Map();
    for (const c of cats.data ?? []) m.set(c.framework, [...(m.get(c.framework) ?? []), c]);
    return [...m.entries()];
  }, [cats.data]);
  return (
    <Field label="Kategorien (Rahmenwerke)">
      {byFramework.map(([framework, list]) => (
        <div key={framework} style={{ marginBottom: 6 }}>
          <strong style={{ fontSize: 12 }}>{framework}</strong>
          <div className="btn-row">
            {list.map((c) => (
              <label key={c.id} className="checkbox" title={c.name}>
                <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((v) => v !== c.id))} />
                {c.key}
              </label>
            ))}
          </div>
        </div>
      ))}
    </Field>
  );
}

function TemplateForm({ onClose, onSaved }) {
  const user = useUser();
  const teams = useTeams();
  const [form, setForm] = useState({ name: '', description: '', type: 'quality', origin: 'private', team_id: '', tags: '', target: 'llm', use_cases: [] });
  const [spec, setSpec] = useState({ config: {}, requires: [], suggested_thresholds: [] });
  const [categoryIds, setCategoryIds] = useState([]);
  const [run, error, busy] = useAction();
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const save = () =>
    run(async () => {
      const saved = await api('/api/catalog/templates', {
        method: 'POST',
        body: { ...form, team_id: form.origin === 'team' ? form.team_id : undefined, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean), spec, category_ids: categoryIds },
      });
      onSaved(saved);
    });
  const myTeams = user.is_admin ? (teams.data ?? []) : (user.teams ?? []);
  return (
    <Modal
      title="Neue Vorlage"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy || !form.name.trim()} onClick={save}>
            Als Entwurf anlegen
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label="Name">
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Testart">
          <select value={form.type} onChange={(e) => set({ type: e.target.value, target: form.type === e.target.value ? form.target : DEFAULT_TARGET[e.target.value] ?? 'llm' })}>
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Test-Ziel" hint="Worauf richtet sich der Test?">
          <select value={form.target} onChange={(e) => set({ target: e.target.value })}>
            {Object.entries(TARGET_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Beschreibung">
        <input value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="form-grid">
        <Field label="Sichtbar für">
          <select value={form.origin} onChange={(e) => set({ origin: e.target.value })}>
            <option value="private">Nur ich</option>
            <option value="team">Ein Team</option>
          </select>
        </Field>
        {form.origin === 'team' && (
          <Field label="Team">
            <select value={form.team_id} onChange={(e) => set({ team_id: e.target.value })}>
              <option value="">Team wählen…</option>
              {myTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Tags (Komma)">
          <input value={form.tags} onChange={(e) => set({ tags: e.target.value })} />
        </Field>
      </div>
      <Field label="Einsatzprofile">
        <div className="btn-row">
          {Object.entries(USE_CASE_LABELS).map(([k, v]) => (
            <label key={k} className="checkbox">
              <input type="checkbox" checked={form.use_cases.includes(k)} onChange={(e) => set({ use_cases: e.target.checked ? [...form.use_cases, k] : form.use_cases.filter((u) => u !== k) })} />
              {v}
            </label>
          ))}
        </div>
      </Field>
      <CategoryPicker value={categoryIds} onChange={setCategoryIds} />
      <SpecEditor spec={spec} onChange={setSpec} />
    </Modal>
  );
}

function VersionEditor({ template, version, onClose, onSaved }) {
  const [spec, setSpec] = useState(version.spec);
  const [changelog, setChangelog] = useState(version.changelog ?? '');
  const [categoryIds, setCategoryIds] = useState((version.categories ?? []).map((c) => c.id));
  const [run, error, busy] = useAction();
  const save = () =>
    run(async () => {
      await api(`/api/catalog/templates/${template.id}/versions/${version.version}`, { method: 'PUT', body: { spec, changelog, category_ids: categoryIds } });
      onSaved();
    });
  return (
    <Modal
      title={`${template.name} ${version.version} bearbeiten`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Änderungsnotiz">
        <input value={changelog} onChange={(e) => setChangelog(e.target.value)} />
      </Field>
      <CategoryPicker value={categoryIds} onChange={setCategoryIds} />
      <SpecEditor spec={spec} onChange={setSpec} />
    </Modal>
  );
}

// ----------------------------------------------------------------------------------------------------------------- Detail

function LifecycleActions({ base, version, canEdit, onChanged, setError }) {
  const user = useUser();
  const reviewer = can(user, 'catalog.publish');
  const act = async (action, body) => {
    try {
      await api(`${base}/versions/${version.version}/${action}`, { method: 'POST', body });
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <span className="btn-row" style={{ flexWrap: 'nowrap' }}>
      {version.status === 'draft' && canEdit && (
        <button className="btn sm" onClick={() => act('submit')}>
          <Send size={13} /> Zur Prüfung
        </button>
      )}
      {version.status === 'review' && reviewer && (
        <>
          <button className="btn sm primary" onClick={() => act('approve', { note: prompt('Anmerkung (optional)') ?? undefined })}>
            <Check size={13} /> Freigeben
          </button>
          <button
            className="btn sm danger"
            onClick={() => {
              const note = prompt('Begründung der Ablehnung');
              if (note) act('reject', { note });
            }}
          >
            Ablehnen
          </button>
        </>
      )}
      {version.status === 'published' && (canEdit || reviewer) && (
        <button className="btn sm" onClick={() => confirm('Version als veraltet markieren? Bestehende Prüfungen laufen weiter, neue können sie nicht mehr wählen.') && act('deprecate')}>
          Veralten lassen
        </button>
      )}
    </span>
  );
}

export function TemplateDetail() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const detail = useApi(`/api/catalog/templates/${id}`);
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);
  const [selected, setSelected] = useState(null);
  const [run, error, , setError] = useAction();

  async function newVersion(t) {
    await run(async () => {
      await api(`/api/catalog/templates/${t.id}/versions`, { method: 'POST', body: { bump: 'minor' } });
      detail.reload();
    });
  }
  async function exportVersion(t, v, format, datasets) {
    await run(async () => {
      const text = await api(`/api/catalog/templates/${t.id}/versions/${v.version}/export?format=${format}${datasets ? '&datasets=1' : ''}`, { raw: true });
      download(`${t.key}-${v.version}.${format === 'json' ? 'json' : 'yaml'}`, text);
    });
  }
  const remove = (t) =>
    confirm('Vorlage mit allen Versionen löschen?') &&
    run(async () => {
      await api(`/api/catalog/templates/${t.id}`, { method: 'DELETE' });
      navigate('/catalog');
    });
  const draftVersion = (t) => t.versions.find((v) => ['draft', 'review'].includes(v.status));

  return (
    <Loading state={detail}>
      {(t) => {
        const shown = t.versions.find((v) => v.version === selected) ?? t.versions.find((v) => v.status === 'published') ?? t.versions[0];
        return (
          <>
            <PageHead
              title={
                <>
                  {t.name} <OriginBadge origin={t.origin} />
                </>
              }
              action={
                <div className="btn-row">
                  {can(user, 'runs.start') && can(user, 'tests.manage') && shown && (
                    <button className="btn" onClick={() => setTesting(shown)}>
                      <Play size={15} /> Testlauf
                    </button>
                  )}
                  {t.can_edit && !draftVersion(t) && (
                    <button className="btn" onClick={() => newVersion(t)}>
                      <Plus size={15} /> Neue Version
                    </button>
                  )}
                  {t.can_edit && (
                    <button className="btn ghost danger" onClick={() => remove(t)} aria-label="Löschen">
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              }
            >
              {t.description} · {TYPE_LABELS[t.type] ?? t.type} · Test-Ziel: {TARGET_LABELS[t.target] ?? t.target}
              {t.owner_name ? ` · von ${t.owner_name}` : ''}
            </PageHead>
            <ErrorBox error={error} />
            <Card title="Versionen" flush>
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Stand</th>
                    <th>Erstellt</th>
                    <th>Prüfung</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {t.versions.map((v) => (
                    <tr key={v.id} onClick={() => setSelected(v.version)} style={{ cursor: 'pointer', fontWeight: shown?.id === v.id ? 600 : 400 }}>
                      <td className="mono">{v.version}</td>
                      <td>
                        <LifecycleBadge status={v.status} />
                        {v.review_note && <div className="sub">Anmerkung: {v.review_note}</div>}
                      </td>
                      <td className="sub">
                        {v.created_by_name} · {fmt.date(v.created_at)}
                        {v.changelog && <div>{v.changelog}</div>}
                      </td>
                      <td className="sub">
                        {v.submitted_by_name && <div>eingereicht: {v.submitted_by_name}</div>}
                        {v.reviewed_by_name && <div>geprüft: {v.reviewed_by_name}</div>}
                      </td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <LifecycleActions base={`/api/catalog/templates/${t.id}`} version={v} canEdit={t.can_edit} onChanged={detail.reload} setError={setError} />
                        {v.status === 'draft' && t.can_edit && (
                          <button className="btn sm ghost" onClick={() => setEditing(v)}>
                            Bearbeiten
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            {shown && (
              <div className="two-col">
                <Card
                  title={`Spezifikation ${shown.version}`}
                  sub={`Hash ${shown.hash.slice(0, 16)}…`}
                  action={
                    <div className="btn-row">
                      <button className="btn sm" onClick={() => exportVersion(t, shown, 'yaml', true)}>
                        <Download size={13} /> YAML
                      </button>
                      <button className="btn sm" onClick={() => exportVersion(t, shown, 'json', true)}>
                        <Download size={13} /> JSON
                      </button>
                    </div>
                  }
                >
                  <div className="tags" style={{ marginBottom: 8 }}>
                    {shown.categories.map((c) => (
                      <span key={c.id} className="tag" title={c.name}>
                        {c.framework} {c.key}
                      </span>
                    ))}
                    {t.use_cases.map((u) => (
                      <span key={u} className="tag">
                        {USE_CASE_LABELS[u]}
                      </span>
                    ))}
                  </div>
                  <pre className="code-block">{JSON.stringify(shown.spec, null, 2)}</pre>
                </Card>
                <div>
                  <Card title="Nutzung">
                    <div className="meta-row">
                      <span>Läufe</span>
                      <span>{t.usage.runs}</span>
                    </div>
                    <div className="meta-row">
                      <span>Erfolgsquote</span>
                      <span>{pctText(t.usage.pass_rate)}</span>
                    </div>
                    <div className="meta-row">
                      <span>Zuletzt genutzt</span>
                      <span>{fmt.ago(t.usage.last_used)}</span>
                    </div>
                    {t.used_by_audits.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {t.used_by_audits.map((a) => (
                          <div key={a.id}>
                            <Link to={`/audits/${a.id}`}>{a.name}</Link>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                  <Card title="Verwendete Datensätze" flush>
                    {(t.datasets ?? []).length === 0 ? (
                      <div className="empty">Diese Vorlage verwendet keinen Datensatz.</div>
                    ) : (
                      <table>
                        <tbody>
                          {t.datasets.map((d) => (
                            <tr key={d.key}>
                              <td>
                                <Link to={`/datasets/${d.id ?? d.key}`}>{d.name ?? d.key}</Link>
                                <div className="sub">
                                  {d.kind}
                                  {d.sensitivity ? ` · ${d.sensitivity}` : ''}
                                </div>
                              </td>
                              <td className="sub">
                                {d.version && <span className="mono">{d.version}</span>}
                                {d.cases != null && <div>{d.cases} Fälle</div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                  <Card title="Zuletzt gemessen" flush>
                    <table>
                      <tbody>
                        {t.recent_results.map((r, i) => (
                          <tr key={i}>
                            <td>{r.model}</td>
                            <td className="sub">{r.path}</td>
                            <td className="mono">{r.version}</td>
                            <td>{r.score === null ? '–' : pctText(r.score)}</td>
                          </tr>
                        ))}
                        {t.recent_results.length === 0 && (
                          <tr>
                            <td className="empty">Noch keine Messung</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </Card>
                </div>
              </div>
            )}
            {editing && <VersionEditor template={t} version={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), detail.reload())} />}
            {testing && <TestRunDialog template={t} version={testing} onClose={() => setTesting(null)} />}
          </>
        );
      }}
    </Loading>
  );
}

// Testlauf einer Vorlage (auch Entwurf) gegen eine Plattform; zählt nicht in Historie und Dashboard.
function TestRunDialog({ template, version, onClose }) {
  const navigate = useNavigate();
  const platforms = useApi('/api/platforms');
  const [platformId, setPlatformId] = useState(getPlatform() ?? '');
  const platform = useApi(platformId ? `/api/platforms/${platformId}` : null);
  const [model, setModel] = useState('');
  const [run, error, busy] = useAction();
  const models = [...new Set((platform.data?.endpoints ?? []).flatMap((e) => (e.models ?? []).filter((m) => m.available && m.portfolio_id).map((m) => m.alias ?? m.name)))];
  const start = () =>
    run(async () => {
      const res = await api(`/api/catalog/templates/${template.id}/versions/${version.version}/test-run`, {
        method: 'POST',
        body: { platform_id: platformId, models: model ? [{ alias: model, path: 'both' }] : undefined },
      });
      navigate(`/runs/${res.id ?? res.run_id}`);
    });
  return (
    <Modal
      title={`Testlauf ${template.name} ${version.version}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!platformId || busy} onClick={start}>
            <Play size={14} /> Starten
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="hint" style={{ marginBottom: 12 }}>
        Ein Testlauf ist ein Probelauf ohne Schwellwerte. Er erscheint nicht in Läufen oder im Dashboard, wird aber protokolliert.
      </div>
      <Field label="Plattform">
        <select value={platformId} onChange={(e) => setPlatformId(e.target.value)}>
          <option value="">Plattform wählen…</option>
          {(platforms.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.environment})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Modell" hint="Leer lässt das Standardmodell der Plattform verwenden.">
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Standard</option>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

// ----------------------------------------------------------------------------------------------------------------- Import

function ImportDialog({ onClose, onDone }) {
  const [content, setContent] = useState('');
  const [result, setResult] = useState(null);
  const [run, error, busy] = useAction();
  const pick = async (file) => {
    if (file) setContent(await file.text());
  };
  const send = () =>
    run(async () => {
      setResult(await api('/api/catalog/import', { method: 'POST', body: { content, format: content.trim().startsWith('{') ? 'json' : 'yaml' } }));
      onDone();
    });
  return (
    <Modal
      title="Vorlage importieren"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Schließen
          </button>
          <button className="btn primary" disabled={!content.trim() || busy} onClick={send}>
            <Upload size={14} /> Importieren
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="hint" style={{ marginBottom: 12 }}>
        Erwartet eine YAML- oder JSON-Datei im Schema <span className="mono">ai-testing-suite/v1</span>. Importiertes landet als privater Entwurf und durchläuft den normalen Freigabeprozess.
      </div>
      <Field label="Datei (.yaml, .yml, .json)">
        <input type="file" accept=".yaml,.yml,.json" onChange={(e) => pick(e.target.files[0])} />
      </Field>
      <Field label="oder Inhalt einfügen">
        <textarea className="mono" rows={10} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
      </Field>
      {result && (
        <div className="hint">
          <strong>Importiert:</strong>
          {result.datasets.map((d) => (
            <div key={d.key}>
              Datensatz {d.key} {d.version} {d.unchanged ? '(unverändert)' : ''}
            </div>
          ))}
          {result.templates.map((t) => (
            <div key={t.key}>
              Vorlage {t.key} {t.version} {t.unchanged ? '(unverändert)' : `(${t.status})`}
            </div>
          ))}
          {result.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
    </Modal>
  );
}
