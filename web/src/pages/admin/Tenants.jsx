import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Empty, ErrorBox, Field, fmt, getTenant, Loading, Modal, PageHead, setTenant, useAction, useApi } from '../../lib.jsx';

export default function Tenants() {
  const list = useApi('/api/tenants');
  const [editing, setEditing] = useState(null);
  const [run, error] = useAction();
  const remove = (t) =>
    confirm(`Mandant „${t.name}“ mit allen Plattformen, Prüfungen, Läufen und Findings löschen? Das lässt sich nicht rückgängig machen.`) &&
    run(async () => {
      await api(`/api/tenants/${t.id}`, { method: 'DELETE' });
      list.reload();
    });
  return (
    <>
      <PageHead
        title="Mandanten"
        action={
          <button className="btn primary" onClick={() => setEditing({})}>
            <Plus size={15} /> Neuer Mandant
          </button>
        }
      >
        Ein Mandant trennt Plattformen, Prüfungen, Datensätze, Zugangsdaten, Läufe, Findings und Berichte vollständig von anderen. Offizielle Vorlagen sind für alle sichtbar.
      </PageHead>
      <ErrorBox error={error} />
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Keine Mandanten.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kürzel</th>
                    <th className="num">Plattformen</th>
                    <th className="num">Mitglieder</th>
                    <th>Angelegt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <button className="title-link" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={() => t.id !== getTenant() && setTenant(t.id)} title="In diesen Mandanten wechseln">
                          {t.name}
                        </button>
                        {t.description && <div className="sub">{t.description}</div>}
                      </td>
                      <td className="mono">{t.key}</td>
                      <td className="num">{t.platforms}</td>
                      <td className="num">{t.members}</td>
                      <td className="sub">{fmt.date(t.created_at)}</td>
                      <td className="num">
                        <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn sm ghost" onClick={() => setEditing(t)} aria-label="Bearbeiten">
                            <Pencil size={14} />
                          </button>
                          {t.key !== 'default' && (
                            <button className="btn sm ghost danger" onClick={() => remove(t)} aria-label="Löschen">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loading>
      {editing && <TenantForm tenant={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />}
    </>
  );
}

function TenantForm({ tenant, onClose, onSaved }) {
  const [form, setForm] = useState({ name: tenant.name ?? '', key: tenant.key ?? '', description: tenant.description ?? '' });
  const [run, error, busy] = useAction();
  const save = () =>
    run(async () => {
      await api(tenant.id ? `/api/tenants/${tenant.id}` : '/api/tenants', { method: tenant.id ? 'PUT' : 'POST', body: form });
      onSaved();
    });
  return (
    <Modal
      title={tenant.id ? 'Mandant bearbeiten' : 'Neuer Mandant'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy || !form.name.trim()} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      {!tenant.id && (
        <Field label="Kürzel (optional)" hint="Wird aus dem Namen gebildet, wenn leer.">
          <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
        </Field>
      )}
      <Field label="Beschreibung">
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
    </Modal>
  );
}
