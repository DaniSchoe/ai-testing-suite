import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, can, fmt, Modal, useApi, useUser } from '../lib.jsx';

const PRESETS = [
  ['*/15 * * * *', 'Alle 15 Minuten'],
  ['0 * * * *', 'Stündlich'],
  ['0 3 * * *', 'Täglich 03:00'],
  ['0 6 * * 1-5', 'Werktags 06:00'],
  ['0 4 * * 0', 'Sonntags 04:00'],
];

export default function Schedules() {
  const user = useUser();
  const schedules = useApi('/api/schedules');
  const [editing, setEditing] = useState(null);

  async function toggle(s) {
    await api(`/api/schedules/${s.id}`, { method: 'PUT', body: { ...s, enabled: !s.enabled } });
    schedules.reload();
  }

  async function remove(s) {
    if (!confirm(`Zeitplan "${s.name}" löschen?`)) return;
    await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
    schedules.reload();
  }

  const target = (s) => (s.target_kind === 'all' ? 'Alle Tests' : s.target_kind === 'suite' ? `Suite: ${s.suite_name}` : `Test: ${s.test_name}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Zeitpläne</h1>
          <p>Tests, Suiten oder alle Tests per Cron-Ausdruck automatisch ausführen.</p>
        </div>
        {can(user, 'schedules.manage') && (
          <button className="btn primary" onClick={() => setEditing({})}>
            <Plus size={15} /> Neuer Zeitplan
          </button>
        )}
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Ziel</th>
              <th>Cron</th>
              <th>Besitzer</th>
              <th>Status</th>
              <th className="num">Zuletzt</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(schedules.data ?? []).map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600 }}>{s.name}</td>
                <td>{target(s)}</td>
                <td>
                  <code>{s.cron}</code>
                  <div className="sub">{PRESETS.find(([c]) => c === s.cron)?.[1] ?? s.timezone}</div>
                </td>
                <td>{s.owner_name ?? '–'}</td>
                <td>
                  <button className={`badge ${s.enabled ? 'passed' : 'cancelled'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => toggle(s)}>
                    {s.enabled ? '✓ Aktiv' : '– Pausiert'}
                  </button>
                </td>
                <td className="num sub">{fmt.ago(s.last_run_at)}</td>
                <td className="num">
                  {can(user, 'schedules.manage') && (s.owner_id === user.id || can(user, 'runs.manage_all')) && (
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn sm ghost" onClick={() => setEditing(s)} aria-label="Bearbeiten">
                        <Pencil size={14} />
                      </button>
                      <button className="btn sm ghost danger" onClick={() => remove(s)} aria-label="Löschen">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {schedules.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Noch keine Zeitpläne
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <ScheduleEditor
          schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            schedules.reload();
          }}
        />
      )}
    </>
  );
}

function ScheduleEditor({ schedule, onClose, onSaved }) {
  const tests = useApi('/api/tests');
  const suites = useApi('/api/suites');
  const [form, setForm] = useState({
    name: schedule.name ?? '',
    target_kind: schedule.target_kind ?? 'suite',
    test_id: schedule.test_id ?? '',
    suite_id: schedule.suite_id ?? '',
    cron: schedule.cron ?? '0 3 * * *',
    timezone: schedule.timezone ?? 'Europe/Berlin',
    enabled: schedule.enabled ?? true,
  });
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    try {
      await api(schedule.id ? `/api/schedules/${schedule.id}` : '/api/schedules', { method: schedule.id ? 'PUT' : 'POST', body: form });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={schedule.id ? 'Zeitplan bearbeiten' : 'Neuer Zeitplan'}
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
      <label className="field">
        <span>Name</span>
        <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Ziel</span>
          <select value={form.target_kind} onChange={(e) => set({ target_kind: e.target.value })}>
            <option value="suite">Suite</option>
            <option value="test">Einzelner Test</option>
            <option value="all">Alle Tests</option>
          </select>
        </label>
        {form.target_kind === 'suite' && (
          <label className="field">
            <span>Suite</span>
            <select value={form.suite_id} onChange={(e) => set({ suite_id: e.target.value })}>
              <option value="">Bitte wählen…</option>
              {(suites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {form.target_kind === 'test' && (
          <label className="field">
            <span>Test</span>
            <select value={form.test_id} onChange={(e) => set({ test_id: e.target.value })}>
              <option value="">Bitte wählen…</option>
              {(tests.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Cron-Ausdruck</span>
          <input value={form.cron} onChange={(e) => set({ cron: e.target.value })} />
          <div className="hint">
            {PRESETS.map(([c, l]) => (
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
      <label className="checkbox">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> aktiv
      </label>
    </Modal>
  );
}
