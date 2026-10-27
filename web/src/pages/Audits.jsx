import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowUpCircle, Pin, Play, Plus, Trash2, X } from 'lucide-react';
import {
  api,
  can,
  Card,
  CRON_PRESETS,
  describeSchedule,
  Empty,
  EnvBadge,
  getPlatform,
  ErrorBox,
  Field,
  fmt,
  Loading,
  Modal,
  OUTCOME_LABELS,
  PageHead,
  PATH_LABELS,
  StatusBadge,
  Tabs,
  TeamPicker,
  useAction,
  useApi,
  useTeams,
  useUser,
  useUserDirectory,
  TYPE_LABELS,
} from '../lib.jsx';
import { ThresholdRows } from './Catalog.jsx';
import { ApprovalsPanel } from './Approvals.jsx';
import { ScheduleList } from './Schedules.jsx';

const outcomeSummary = (o) =>
  Object.entries(o ?? {})
    .map(([k, n]) => `${n} ${OUTCOME_LABELS[k] ?? k}`)
    .join(' · ');

export function Audits() {
  const user = useUser();
  const list = useApi('/api/audits', { interval: 15000 });
  const [starting, setStarting] = useState(null);
  const [tab, setTab] = useState('audits');
  const platformId = getPlatform();
  const rows = (list.data ?? []).filter((a) => !platformId || a.platform_id === platformId);
  const pending = useApi(can(user, 'runs.prod') ? '/api/approvals/summary' : null, { interval: 30000 });
  return (
    <>
      <PageHead
        title="Prüfungen"
        action={
          can(user, 'tests.manage') && (
            <Link className="btn primary" to="/audits/new">
              <Plus size={15} /> Neue Prüfung
            </Link>
          )
        }
      >
        Eine Prüfung legt fest, was gegen welche Plattform mit welchen Modellen geprüft wird und welche Schwellwerte gelten. Sie verweist auf feste Versionen von Vorlagen und Datensätzen.
      </PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['audits', 'Prüfungen'],
          ['approvals', pending.data?.pending ? `Freigaben (${pending.data.pending} offen)` : 'Freigaben'],
          ['schedules', 'Zeitpläne'],
        ]}
      />
      {tab === 'schedules' && <ScheduleList />}
      {tab === 'approvals' && <ApprovalsPanel />}
      {tab === 'audits' && <Loading state={list}>
        {() =>
          rows.length === 0 ? (
            <Empty>Noch keine Prüfungen.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Prüfung</th>
                    <th>Ziel</th>
                    <th>Umfang</th>
                    <th>Letzter Lauf</th>
                    <th>Zeitplan</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td style={{ minWidth: 220 }}>
                        <Link className="title-link" to={`/audits/${a.id}`}>
                          {a.name}
                        </Link>
                        {a.description && <div className="sub">{a.description}</div>}
                      </td>
                      <td>
                        {a.platform_name} <EnvBadge env={a.platform_environment} />
                        {a.platform_locked && <span className="badge failed">gesperrt</span>}
                      </td>
                      <td className="sub">
                        {a.items.length} Vorlagen · {a.models.length} Modelle
                        {a.repeats > 1 ? ` · ${a.repeats}× wiederholt` : ''}
                        {a.mode === 'compare' ? ' · Vergleich' : ''}
                      </td>
                      <td>
                        {a.last_status ? <StatusBadge status={a.last_status} /> : '–'}
                        <div className="sub">{a.last_outcomes ? outcomeSummary(a.last_outcomes) : fmt.ago(a.last_run_at)}</div>
                      </td>
                      <td className="sub">{describeSchedule(a) ?? '–'}</td>
                      <td className="num">
                        {can(user, 'runs.start') && (
                          <button className="btn sm" onClick={() => setStarting(a)}>
                            <Play size={13} /> Starten
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>}
      {starting && <StartDialog audit={starting} onClose={() => setStarting(null)} />}
    </>
  );
}

// Vorabprüfung vor dem Start: nicht anwendbare Kombinationen, Dauer, Freigabebedarf.
export function StartDialog({ audit, onClose }) {
  const user = useUser();
  const navigate = useNavigate();
  const pre = useApi(`/api/audits/${audit.id}/preflight`);
  const keys = useApi('/api/api-keys');
  const [keyId, setKeyId] = useState('');
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const teams = useApi('/api/teams');
  const directory = useApi('/api/user-directory');
  const [run, error, busy] = useAction();
  const p = pre.data;
  const start = () =>
    run(async () => {
      const res = await api(`/api/audits/${audit.id}/run`, { method: 'POST', body: { api_key_id: keyId || undefined } });
      navigate(`/runs/${res.id}`);
    });
  const request = () =>
    run(async () => {
      await api(`/api/audits/${audit.id}/approvals`, { method: 'POST', body: { note, assigned_team_id: assignee.startsWith('team:') ? assignee.slice(5) : undefined, assigned_user_id: assignee.startsWith('user:') ? assignee.slice(5) : undefined } });
      pre.reload();
    });
  return (
    <Modal
      title={`${audit.name} starten`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!p?.can_start || busy} onClick={start}>
            <Play size={14} /> Jetzt starten
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {!p && <div className="empty">Prüfe…</div>}
      {p && (
        <>
          <div className="meta-row">
            <span>Einzeltests</span>
            <span>
              {p.applicable} von {p.count} anwendbar
            </span>
          </div>
          <div className="meta-row">
            <span>Geschätzte Dauer</span>
            <span>{fmt.ms(p.estimate_ms)}</span>
          </div>
          <div className="meta-row">
            <span>Ziel</span>
            <span>
              {p.platform.name} <EnvBadge env={p.platform.environment} />
            </span>
          </div>
          {p.platform.locked && <div className="error-box">Plattform gesperrt: {p.platform.locked_reason ?? 'Kill-Switch aktiv'}</div>}
          {p.not_applicable.length > 0 && (
            <div className="hint" style={{ margin: '10px 0' }}>
              Nicht anwendbar (wird übersprungen):
              {p.not_applicable.map((n, i) => (
                <div key={i}>
                  {n.name}: {n.reason}
                </div>
              ))}
            </div>
          )}
          {p.approval_needed.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="hint">Freigabe nötig ({p.approval_needed.join(', ')}), erteilt nach dem Vier-Augen-Prinzip.</div>
              {p.approval && (
                <div className="badge passed" style={{ marginTop: 6 }}>
                  Freigabe gültig{p.approval.window_to ? ` bis ${fmt.date(p.approval.window_to)}` : ''}, {p.approval.runs_left} Lauf/Läufe übrig
                </div>
              )}
              {!p.approval && p.approval_pending && <div className="badge running">Antrag liegt vor seit {fmt.date(p.approval_pending.requested_at)}</div>}
              {!p.approval && !p.approval_pending && (
                <>
                  <Field label="Begründung für den Antrag">
                    <input value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <Field label="Zuweisen an" hint="Nur die zugewiesene Person bzw. Prüfer des Teams sehen den Antrag. Ohne Auswahl sehen ihn alle Prüfer.">
                    <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                      <option value="">Alle Prüfer</option>
                      <optgroup label="Team">
                        {(teams.data ?? []).map((t) => (
                          <option key={t.id} value={`team:${t.id}`}>
                            {t.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Person">
                        {(directory.data ?? []).filter((u) => u.id !== user.id).map((u) => (
                          <option key={u.id} value={`user:${u.id}`}>
                            {u.name ?? u.display_name ?? u.username}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </Field>
                  <button className="btn" onClick={request} disabled={busy}>
                    Freigabe beantragen
                  </button>
                </>
              )}
            </div>
          )}
          <Field label="API-Key für diesen Lauf (optional, sonst der Key der Prüfung)">
            <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">Key der Prüfung</option>
              {(keys.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------------------------------------------------------- Editor

const EMPTY = {
  name: '',
  description: '',
  tags: '',
  platform_id: getPlatform() ?? '',
  api_key_id: '',
  maintainer_id: '',
  visibility: 'private',
  teamIds: [],
  items: [],
  models: [],
  repeats: 1,
  mode: 'standard',
  compare: { kind: 'models', a: '', b: '', path: 'gateway', model: '' },
  regression_tolerance: 0.2,
  baseline_auto: true,
  load_limits: {},
  gate: { fail_on: ['security_finding', 'technical_error'] },
};

export function AuditEditor() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const existing = useApi(id ? `/api/audits/${id}` : null);
  const [form, setForm] = useState(id ? null : EMPTY);
  const [tab, setTab] = useState('general');
  const [run, error, busy] = useAction();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const a = existing.data;
    if (!a) return;
    setForm({
      ...EMPTY,
      ...a,
      tags: (a.tags ?? []).join(', '),
      api_key_id: a.api_key_id ?? '',
      maintainer_id: a.maintainer_id ?? '',
      compare: { ...EMPTY.compare, ...(a.compare ?? {}) },
      load_limits: a.load_limits ?? {},
      gate: { fail_on: a.gate?.fail_on ?? EMPTY.gate.fail_on },
    });
  }, [existing.data]);

  if (id && existing.error) return <ErrorBox error={existing.error} />;
  if (!form) return <Empty>Lädt…</Empty>;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const editable = !id || existing.data?.can_edit;

  const payload = () => ({
    ...form,
    tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    api_key_id: form.api_key_id || null,
    maintainer_id: form.maintainer_id || null,
    compare: form.mode === 'compare' ? form.compare : null,
    items: form.items.map((i) => ({ template_version_id: i.template_version_id, thresholds: i.thresholds, endpoint_id: i.endpoint_id })),
    models: form.mode === 'compare' ? [] : form.models,
  });
  const save = () =>
    run(async () => {
      const saved = await api(id ? `/api/audits/${id}` : '/api/audits', { method: id ? 'PUT' : 'POST', body: payload() });
      if (id) existing.reload();
      else navigate(`/audits/${saved.id}`, { replace: true });
    });
  const remove = () =>
    confirm('Prüfung löschen? Bisherige Läufe bleiben erhalten.') &&
    run(async () => {
      await api(`/api/audits/${id}`, { method: 'DELETE' });
      navigate('/audits');
    });

  const a = existing.data;
  return (
    <>
      <PageHead
        title={id ? form.name : 'Neue Prüfung'}
        action={
          <div className="btn-row">
            {id && can(user, 'runs.start') && (
              <button className="btn" onClick={() => setStarting(true)}>
                <Play size={15} /> Starten
              </button>
            )}
            {editable && (
              <button className="btn primary" onClick={save} disabled={busy || !form.name.trim() || !form.platform_id}>
                Speichern
              </button>
            )}
            {id && a?.can_edit && (
              <button className="btn ghost danger" onClick={remove} aria-label="Löschen">
                <Trash2 size={15} />
              </button>
            )}
          </div>
        }
      >
        {id && a ? `${a.platform_name} · ${a.run_count} Läufe` : 'Ziel, Umfang, Modelle und Schwellwerte festlegen.'}
      </PageHead>
      <ErrorBox error={error} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['general', 'Allgemein'],
          ['scope', `Prüfumfang (${form.items.length})`],
          ['models', 'Modelle & Wiederholung'],
          ['schedule', 'Zeitplan'],
          ...(id ? [['runs', 'Läufe & Baseline']] : []),
        ]}
      />
      {tab === 'general' && <General form={form} set={set} editable={editable} />}
      {tab === 'scope' && <Scope form={form} set={set} editable={editable} auditId={id} onAdopted={existing.reload} />}
      {tab === 'models' && <ModelsTab form={form} set={set} editable={editable} />}
      {tab === 'schedule' && (id ? <ScheduleTab audit={a} onChanged={existing.reload} /> : <Empty>Speichere die Prüfung zuerst, dann kannst du einen Zeitplan anlegen.</Empty>)}
      {tab === 'runs' && a && <RunsTab audit={a} onChanged={existing.reload} />}
      <Preview form={form} payload={payload} />
      {starting && a && <StartDialog audit={a} onClose={() => setStarting(false)} />}
    </>
  );
}

function General({ form, set, editable }) {
  const platforms = useApi('/api/platforms');
  const keys = useApi('/api/api-keys');
  const teams = useTeams();
  const users = useUserDirectory();
  const user = useUser();
  const myTeams = user.is_admin ? (teams.data ?? []) : (user.teams ?? []);
  return (
    <Card title="Allgemein">
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field label="Name">
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Ziel (Plattform)" hint="Prod-Plattformen verlangen eine Freigabe vor jedem Lauf.">
            <select value={form.platform_id} onChange={(e) => set({ platform_id: e.target.value, models: [] })}>
              <option value="">Plattform wählen…</option>
              {(platforms.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.environment})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Beschreibung">
          <input value={form.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div className="form-grid">
          <Field label="API-Key" hint="Der Key des Gateways, mit dem geprüft wird. Zugriffstests nutzen den Key der jeweiligen Prüfung.">
            <select value={form.api_key_id} onChange={(e) => set({ api_key_id: e.target.value })}>
              <option value="">– keiner –</option>
              {(keys.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Verantwortlich">
            <select value={form.maintainer_id} onChange={(e) => set({ maintainer_id: e.target.value })}>
              <option value="">– keiner –</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sichtbar für">
            <select value={form.visibility} onChange={(e) => set({ visibility: e.target.value })}>
              <option value="private">Nur ich</option>
              <option value="teams">Bestimmte Teams</option>
              <option value="global">Alle im Mandanten</option>
            </select>
          </Field>
          <Field label="Tags (Komma)">
            <input value={form.tags} onChange={(e) => set({ tags: e.target.value })} />
          </Field>
        </div>
        {form.visibility === 'teams' && <TeamPicker teams={myTeams} value={form.teamIds} onChange={(v) => set({ teamIds: v })} />}
      </fieldset>
    </Card>
  );
}

function Scope({ form, set, editable, auditId, onAdopted }) {
  const templates = useApi('/api/catalog/templates?status=published');
  const [adding, setAdding] = useState(false);
  const [run, error] = useAction();
  const move = (i, patch) => set({ items: form.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });

  async function adopt(i) {
    await run(async () => {
      await api(`/api/audits/${auditId}/items/${i}/update`, { method: 'POST' });
      onAdopted();
    });
  }
  return (
    <Card
      title="Prüfumfang"
      sub="Vorlagen werden mit ihrer festen Version übernommen. Neuere Versionen übernimmst du bewusst; die Baseline sollte danach neu gesetzt werden."
      action={
        editable && (
          <button className="btn sm" onClick={() => setAdding(true)}>
            <Plus size={13} /> Vorlage
          </button>
        )
      }
    >
      <ErrorBox error={error} />
      {form.items.length === 0 && <Empty>Noch nichts ausgewählt.</Empty>}
      {form.items.map((it, i) => (
        <div key={`${it.template_version_id}-${i}`} className="card" style={{ marginBottom: 10, padding: 12 }}>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{it.name ?? it.key}</strong> <span className="mono sub">{it.version}</span>{' '}
              <span className="tag">{TYPE_LABELS[it.type] ?? it.type}</span>
              {it.requires?.length > 0 && <span className="sub"> braucht {it.requires.join(', ')}</span>}
              {it.update_available && (
                <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => adopt(i)} disabled={!auditId} title="Neuere veröffentlichte Version übernehmen">
                  <ArrowUpCircle size={13} /> Version {it.update_available.version} übernehmen
                </button>
              )}
            </div>
            {editable && (
              <button className="btn ghost sm" onClick={() => set({ items: form.items.filter((_, j) => j !== i) })} aria-label="Entfernen">
                <X size={14} />
              </button>
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              Schwellwerte {it.thresholds === undefined && '(Vorgabe der Vorlage)'}
            </div>
            {editable ? (
              <ThresholdRows value={it.thresholds ?? it.suggested_thresholds ?? []} onChange={(v) => move(i, { thresholds: v })} />
            ) : (
              (it.thresholds ?? []).map((r, j) => (
                <span key={j} className="tag">
                  {r.metric} {r.op} {r.value}
                </span>
              ))
            )}
          </div>
        </div>
      ))}
      {adding && (
        <AddItems
          templates={templates.data ?? []}
          onClose={() => setAdding(false)}
          onAdd={(add) => (set({ items: [...form.items, ...add] }), setAdding(false))}
        />
      )}
    </Card>
  );
}

function AddItems({ templates, onAdd, onClose }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const shown = templates.filter((t) => `${t.name} ${t.key}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  function add() {
    const out = [];
    for (const key of picked) {
      const t = templates.find((x) => x.id === key);
      const spec = t.latest;
      out.push({ template_version_id: spec.id, name: t.name, key: t.key, version: spec.version, type: t.type, requires: spec.requires });
    }
    onAdd(out);
  }
  return (
    <Modal
      title="Vorlagen hinzufügen"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!picked.length} onClick={add}>
            {picked.length} hinzufügen
          </button>
        </>
      }
    >
      <input type="search" placeholder="Suchen…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
      <div className="nav-section">Vorlagen</div>
      <div className="pick-list" style={{ maxHeight: 340 }}>
        {shown.map((t) => (
          <label key={t.id}>
            <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
            <span style={{ fontWeight: 600 }}>{t.name}</span> <span className="sub mono">{t.latest.version}</span>
            <span className="sub"> {TYPE_LABELS[t.type]}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ModelsTab({ form, set, editable }) {
  const platform = useApi(form.platform_id ? `/api/platforms/${form.platform_id}` : null);
  const aliases = useMemo(() => {
    const names = new Set();
    for (const e of platform.data?.endpoints ?? []) for (const m of e.models ?? []) if (m.available && m.portfolio_id) names.add(m.alias ?? m.name);
    return [...names].sort();
  }, [platform.data]);
  const selected = new Map(form.models.map((m) => [m.alias, m.path]));
  const toggle = (alias, on) => set({ models: on ? [...form.models, { alias, path: 'gateway' }] : form.models.filter((m) => m.alias !== alias) });
  const setPath = (alias, path) => set({ models: form.models.map((m) => (m.alias === alias ? { ...m, path } : m)) });
  const cmp = form.compare;
  const setCmp = (patch) => set({ compare: { ...cmp, ...patch } });
  const limits = form.load_limits ?? {};
  const failOn = form.gate.fail_on;
  return (
    <>
      <Card title="Modus">
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="segmented">
            <button className={form.mode === 'standard' ? 'active' : ''} onClick={() => set({ mode: 'standard' })}>
              Modell × Pfad
            </button>
            <button className={form.mode === 'compare' ? 'active' : ''} onClick={() => set({ mode: 'compare' })}>
              Vergleich A/B
            </button>
          </div>
          {form.mode === 'compare' && (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="Vergleich">
                <select value={cmp.kind} onChange={(e) => setCmp({ kind: e.target.value })}>
                  <option value="models">Zwei Modelle</option>
                  <option value="paths">Direkt gegen Gateway (ein Modell)</option>
                </select>
              </Field>
              {cmp.kind === 'models' ? (
                <>
                  {['a', 'b'].map((k) => (
                    <Field key={k} label={`Modell ${k.toUpperCase()}`}>
                      <select value={cmp[k]} onChange={(e) => setCmp({ [k]: e.target.value })}>
                        <option value="">wählen…</option>
                        {aliases.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </Field>
                  ))}
                  <Field label="Pfad">
                    <select value={cmp.path} onChange={(e) => setCmp({ path: e.target.value })}>
                      <option value="gateway">über Gateway</option>
                      <option value="direct">direkt</option>
                    </select>
                  </Field>
                </>
              ) : (
                <Field label="Modell">
                  <select value={cmp.model} onChange={(e) => setCmp({ model: e.target.value })}>
                    <option value="">wählen…</option>
                    {aliases.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
        </fieldset>
      </Card>
      {form.mode === 'standard' && (
        <Card title="Modelle und Pfad" sub="„Direkt“ geht am Gateway vorbei zum Modell-Server, „Gateway“ nutzt den Key der Prüfung. Bei „beide“ entstehen zwei Messungen.">
          {!form.platform_id && <Empty>Wähle zuerst unter „Allgemein“ eine Plattform.</Empty>}
          {aliases.map((alias) => (
            <div key={alias} className="meta-row">
              <label className="checkbox">
                <input type="checkbox" disabled={!editable} checked={selected.has(alias)} onChange={(e) => toggle(alias, e.target.checked)} />
                {alias}
              </label>
              {selected.has(alias) && (
                <select disabled={!editable} value={selected.get(alias)} onChange={(e) => setPath(alias, e.target.value)}>
                  {Object.entries(PATH_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </Card>
      )}
      <Card title="Wiederholung, Baseline und Gate">
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="form-grid">
            <Field label="Wiederholungen" hint="Median über mehrere Läufe; die Streuung wird im Ergebnis ausgewiesen.">
              <input type="number" min={1} max={20} value={form.repeats} onChange={(e) => set({ repeats: Number(e.target.value) })} />
            </Field>
            <Field label="Toleranz gegenüber der Baseline" hint="0,2 = 20 % Verschlechterung gelten als Regression.">
              <input type="number" step="0.05" min={0} max={5} value={form.regression_tolerance} onChange={(e) => set({ regression_tolerance: Number(e.target.value) })} />
            </Field>
            <Field label="Max. Parallelität (Lasttests)">
              <input type="number" min={1} value={limits.max_concurrency ?? ''} onChange={(e) => set({ load_limits: { ...limits, max_concurrency: e.target.value } })} />
            </Field>
            <Field label="Max. Dauer in Sekunden (Lasttests)">
              <input type="number" min={1} value={limits.max_duration_s ?? ''} onChange={(e) => set({ load_limits: { ...limits, max_duration_s: e.target.value } })} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={form.baseline_auto} onChange={(e) => set({ baseline_auto: e.target.checked })} />
            Der erste abgeschlossene Lauf wird automatisch zur Baseline
          </label>
          <Field label="Gate (CI/CD): Diese Ergebnisse lassen die Pipeline scheitern">
            <div className="btn-row">
              {[
                ['security_finding', 'Sicherheitsbefund'],
                ['technical_error', 'Technischer Fehler'],
                ['quality_deviation', 'Qualitätsabweichung'],
                ['regression', 'Regression zur Baseline'],
              ].map(([k, label]) => (
                <label key={k} className="checkbox">
                  <input type="checkbox" checked={failOn.includes(k)} onChange={(e) => set({ gate: { fail_on: e.target.checked ? [...failOn, k] : failOn.filter((x) => x !== k) } })} />
                  {label}
                </label>
              ))}
            </div>
          </Field>
        </fieldset>
      </Card>
    </>
  );
}

function ScheduleTab({ audit, onChanged }) {
  const [mode, setMode] = useState(audit.schedule_run_at ? 'once' : 'cron');
  const [cron, setCron] = useState(audit.schedule_cron ?? '0 3 * * *');
  const [runAt, setRunAt] = useState('');
  const [enabled, setEnabled] = useState(audit.schedule_enabled ?? true);
  const [run, error, busy] = useAction();
  const save = () =>
    run(async () => {
      const body = { audit_id: audit.id, enabled, ...(mode === 'once' ? { run_at: new Date(runAt).toISOString() } : { cron }) };
      await api(audit.schedule_id ? `/api/schedules/${audit.schedule_id}` : '/api/schedules', { method: audit.schedule_id ? 'PUT' : 'POST', body });
      onChanged();
    });
  const remove = () =>
    run(async () => {
      await api(`/api/schedules/${audit.schedule_id}`, { method: 'DELETE' });
      onChanged();
    });
  return (
    <Card title="Zeitplan" sub="Geplante Läufe starten mit den Rechten der Person, die den Zeitplan angelegt hat. Läufe auf Prod brauchen weiterhin eine gültige Freigabe; fehlt sie, wird der Lauf übersprungen und im Audit-Log vermerkt.">
      <ErrorBox error={error} />
      {audit.schedule_id && <div className="hint">Aktuell: {describeSchedule(audit)}</div>}
      <div className="segmented" style={{ margin: '8px 0' }}>
        <button className={mode === 'cron' ? 'active' : ''} onClick={() => setMode('cron')}>
          Wiederkehrend
        </button>
        <button className={mode === 'once' ? 'active' : ''} onClick={() => setMode('once')}>
          Einmalig
        </button>
      </div>
      {mode === 'cron' ? (
        <div className="form-grid">
          <Field label="Voreinstellung">
            <select value={CRON_PRESETS.some(([c]) => c === cron) ? cron : ''} onChange={(e) => e.target.value && setCron(e.target.value)}>
              <option value="">eigener Ausdruck</option>
              {CRON_PRESETS.map(([c, label]) => (
                <option key={c} value={c}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cron-Ausdruck (5 Felder, Europe/Berlin)">
            <input className="mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          </Field>
        </div>
      ) : (
        <Field label="Zeitpunkt">
          <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
        </Field>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> aktiv
      </label>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={save} disabled={busy || (mode === 'once' && !runAt)}>
          Zeitplan speichern
        </button>
        {audit.schedule_id && (
          <button className="btn danger" onClick={remove} disabled={busy}>
            Entfernen
          </button>
        )}
      </div>
    </Card>
  );
}

function RunsTab({ audit, onChanged }) {
  const [run, error] = useAction();
  const setBaseline = (runId) =>
    run(async () => {
      await api(`/api/audits/${audit.id}/baseline`, { method: 'POST', body: { run_id: runId } });
      onChanged();
    });
  return (
    <>
      <ErrorBox error={error} />
      <Card title="Baseline" sub="Referenzlauf, gegen den Regressionen berechnet werden. Wird ausdrücklich von Menschen gesetzt.">
        {audit.baseline_run_id ? (
          <div className="btn-row">
            <Link to={`/runs/${audit.baseline_run_id}`}>Baseline-Lauf ansehen</Link>
            {audit.can_edit && (
              <button className="btn sm" onClick={() => setBaseline(null)}>
                Baseline entfernen
              </button>
            )}
          </div>
        ) : (
          <div className="hint">{audit.baseline_auto ? 'Der erste abgeschlossene Lauf wird zur Baseline.' : 'Keine Baseline gesetzt.'}</div>
        )}
      </Card>
      <Card title="Letzte Läufe" flush>
        <table>
          <tbody>
            {audit.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`}>{fmt.date(r.created_at)}</Link>
                  {audit.baseline_run_id === r.id && <span className="tag" style={{ marginLeft: 6 }}>Baseline</span>}
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="sub">{outcomeSummary(r.outcomes)}</td>
                <td>{r.user_name}</td>
                <td className="num">
                  {audit.can_edit && ['passed', 'failed'].includes(r.status) && audit.baseline_run_id !== r.id && (
                    <button className="btn sm" onClick={() => setBaseline(r.id)}>
                      <Pin size={13} /> Als Baseline
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {audit.runs.length === 0 && (
              <tr>
                <td className="empty">Noch keine Läufe</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {audit.approvals.length > 0 && (
        <Card title="Freigaben" flush>
          <table>
            <tbody>
              {audit.approvals.map((ap) => (
                <tr key={ap.id}>
                  <td>{fmt.date(ap.requested_at)}</td>
                  <td>{ap.requested_by_name}</td>
                  <td>{ap.status}</td>
                  <td className="sub">{ap.decided_by_name ? `von ${ap.decided_by_name}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

// Vorschau der Planung (Einzeltests, nicht anwendbar, Dauer, Freigabebedarf), aktualisiert sich bei Änderungen.
function Preview({ form, payload }) {
  const [data, setData] = useState(null);
  const key = JSON.stringify([form.platform_id, form.items.map((i) => i.template_version_id), form.models, form.repeats, form.mode, form.compare, form.load_limits]);
  useEffect(() => {
    if (!form.platform_id || !form.items.length) return setData(null);
    const t = setTimeout(() => {
      api('/api/audits/preview', { method: 'POST', body: payload() })
        .then(setData)
        .catch((e) => setData({ error: e.message }));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!data) return null;
  return (
    <Card title="Vorschau">
      {data.error ? (
        <div className="hint">{data.error}</div>
      ) : (
        <>
          <div className="meta-row">
            <span>Einzeltests</span>
            <span>
              {data.applicable} von {data.count} anwendbar
            </span>
          </div>
          <div className="meta-row">
            <span>Geschätzte Dauer</span>
            <span>{fmt.ms(data.estimate_ms)}</span>
          </div>
          {data.approval_needed.length > 0 && <div className="hint">Freigabe nötig: {data.approval_needed.join(', ')}</div>}
          {data.not_applicable.map((n, i) => (
            <div key={i} className="hint">
              Nicht anwendbar: {n.name} ({n.reason})
            </div>
          ))}
        </>
      )}
    </Card>
  );
}
