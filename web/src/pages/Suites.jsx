import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api, can, Modal, TYPE_LABELS, useApi, useUser } from '../lib.jsx';

export default function Suites() {
  const user = useUser();
  const navigate = useNavigate();
  const suites = useApi('/api/suites');
  const tests = useApi('/api/tests');
  const [editing, setEditing] = useState(null);
  const testName = (id) => tests.data?.find((t) => t.id === id)?.name ?? 'gelöschter Test';

  async function run(suite) {
    const r = await api('/api/runs', { method: 'POST', body: { kind: 'suite', suiteId: suite.id } });
    navigate(`/runs/${r.id}`);
  }

  async function remove(suite) {
    if (!confirm(`Suite "${suite.name}" löschen?`)) return;
    await api(`/api/suites/${suite.id}`, { method: 'DELETE' });
    suites.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Testläufe bündeln</h1>
          <p>Mehrere Tests zu einer Suite zusammenfassen, z. B. für einen nächtlichen Gesamtlauf.</p>
        </div>
        {can(user, 'tests.manage') && (
          <button className="btn primary" onClick={() => setEditing({})}>
            <Plus size={15} /> Neue Suite
          </button>
        )}
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Suite</th>
              <th>Enthaltene Tests</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(suites.data ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div className="sub">{s.description}</div>
                </td>
                <td>
                  <div className="sub">{s.test_ids.length} Tests</div>
                  {s.test_ids.slice(0, 6).map((id) => (
                    <span className="tag" key={id} style={{ marginRight: 4, marginTop: 4 }}>
                      {testName(id)}
                    </span>
                  ))}
                  {s.test_ids.length > 6 && <span className="sub"> +{s.test_ids.length - 6}</span>}
                </td>
                <td className="num">
                  <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    {can(user, 'runs.start') && (
                      <button className="btn sm" onClick={() => run(s)} disabled={!s.test_ids.length}>
                        <Play size={13} /> Starten
                      </button>
                    )}
                    {can(user, 'tests.manage') && (
                      <>
                        <button className="btn sm ghost" onClick={() => setEditing(s)} aria-label="Bearbeiten">
                          <Pencil size={14} />
                        </button>
                        <button className="btn sm ghost danger" onClick={() => remove(s)} aria-label="Löschen">
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {suites.data?.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  Noch keine Suiten
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <SuiteEditor
          suite={editing}
          tests={tests.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            suites.reload();
          }}
        />
      )}
    </>
  );
}

function SuiteEditor({ suite, tests, onClose, onSaved }) {
  const [name, setName] = useState(suite.name ?? '');
  const [description, setDescription] = useState(suite.description ?? '');
  const [ids, setIds] = useState(suite.test_ids ?? []);
  const [error, setError] = useState(null);

  async function save() {
    try {
      await api(suite.id ? `/api/suites/${suite.id}` : '/api/suites', {
        method: suite.id ? 'PUT' : 'POST',
        body: { name, description, test_ids: ids },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={suite.id ? 'Suite bearbeiten' : 'Neue Suite'}
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
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Beschreibung</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="field">
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
          Tests (Reihenfolge der Auswahl = Ausführungsreihenfolge)
        </span>
        <div className="card" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {tests.map((t) => (
            <label key={t.id} className="checkbox" style={{ display: 'flex', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <input
                type="checkbox"
                checked={ids.includes(t.id)}
                onChange={(e) => setIds(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))}
              />
              <span style={{ flex: 1 }}>{t.name}</span>
              <span className="sub">{TYPE_LABELS[t.type]}</span>
              {ids.includes(t.id) && <span className="badge">#{ids.indexOf(t.id) + 1}</span>}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
