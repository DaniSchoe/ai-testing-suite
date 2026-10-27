import { useState } from 'react';
import { Building2, ChevronRight, Network, Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import { api, can, Empty, ErrorBox, Field, Loading, Modal, PageHead, setTenant, useAction, useApi, useUser } from '../../lib.jsx';
import { TeamEditor } from './Teams.jsx';

// Organisation als Hierarchie: Mandant -> Abteilung -> Teams. Bearbeitet wird nur im aktuellen Mandanten.
function DepartmentEditor({ department, onClose, onSaved }) {
  const [form, setForm] = useState({ name: department.name ?? '', description: department.description ?? '' });
  const [run, error, busy] = useAction();
  const save = () =>
    run(async () => {
      await api(department.id ? `/api/departments/${department.id}` : '/api/departments', { method: department.id ? 'PUT' : 'POST', body: form });
      onSaved();
    });
  return (
    <Modal
      title={department.id ? `Abteilung ${department.name} bearbeiten` : 'Neue Abteilung'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            Speichern
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label="Name">
          <input value={form.name} placeholder="z. B. Forschung & Entwicklung" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Beschreibung">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
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

function Tree({ newTenant, onNewTenantClosed }) {
  const user = useUser();
  const org = useApi('/api/organization');
  const users = useApi(can(user, 'users.manage') || can(user, 'teams.manage') ? '/api/members' : null);
  const [dept, setDept] = useState(null);
  const [team, setTeam] = useState(null);
  const [tenant, setTenantEdit] = useState(null);
  const manageTenants = can(user, 'tenants.manage');
  const [run, error] = useAction();
  const edit = can(user, 'teams.manage');
  const teamList = useApi(edit ? '/api/teams' : null);
  const removeDept = (d) =>
    confirm(`Abteilung „${d.name}“ löschen? Die Teams bleiben erhalten und stehen danach ohne Abteilung.`) &&
    run(async () => {
      await api(`/api/departments/${d.id}`, { method: 'DELETE' });
      org.reload();
    });
  const removeTeam = (t) =>
    confirm(`Team „${t.name}“ löschen? Die User bleiben erhalten.`) &&
    run(async () => {
      await api(`/api/teams/${t.id}`, { method: 'DELETE' });
      org.reload();
    });
  const removeTenant = (t) =>
    confirm(`Mandant „${t.name}“ mit allen Plattformen, Prüfungen, Läufen und Findings löschen? Das lässt sich nicht rückgängig machen.`) &&
    run(async () => {
      await api(`/api/tenants/${t.id}`, { method: 'DELETE' });
      org.reload();
    });
  const openTeam = (t) => setTeam(teamList.data?.find((x) => x.id === t.id) ?? { members: [], ...t });

  const TeamRow = ({ t, current, departments }) => (
    <div className="org-row org-team">
      <UsersIcon size={15} />
      <span className="org-name">{t.name}</span>
      <span className="sub">{t.members} Mitglieder</span>
      {current && edit && (
        <span className="btn-row org-actions">
          <button className="btn sm ghost" onClick={() => openTeam(t)} aria-label={`${t.name} bearbeiten`}>
            <Pencil size={14} />
          </button>
          <button className="btn sm ghost danger" onClick={() => removeTeam(t)} aria-label={`${t.name} löschen`}>
            <Trash2 size={14} />
          </button>
        </span>
      )}
    </div>
  );

  return (
    <>
      <ErrorBox error={error} />
      <Loading state={org}>
        {(tenants) =>
          tenants.length === 0 ? (
            <Empty>Keine Mandanten.</Empty>
          ) : (
            <div className="org-tree">
              {tenants.map((t) => (
                <div key={t.id} className="card org-tenant">
                  <div className="org-row org-head">
                    <Building2 size={17} />
                    <strong className="org-name">{t.name}</strong>
                    {t.current ? <span className="tag">aktuell</span> : null}
                    {t.description && <span className="sub">{t.description}</span>}
                    <span className="btn-row org-actions">
                      {manageTenants && (
                        <>
                          <button className="btn sm ghost" onClick={() => setTenantEdit(t)} aria-label={`${t.name} bearbeiten`}>
                            <Pencil size={14} />
                          </button>
                          {t.key !== 'default' && (
                            <button className="btn sm ghost danger" onClick={() => removeTenant(t)} aria-label={`${t.name} löschen`}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                      {t.current && edit && (
                        <>
                          <button className="btn sm" onClick={() => setDept({})}>
                            <Plus size={14} /> Abteilung
                          </button>
                          <button className="btn sm" onClick={() => setTeam({ members: [] })}>
                            <Plus size={14} /> Team
                          </button>
                        </>
                      )}
                      {!t.current && (
                        <button className="btn sm" onClick={() => setTenant(t.id)}>
                          Wechseln, um zu bearbeiten
                        </button>
                      )}
                    </span>
                  </div>
                  {t.departments.length === 0 && t.teams.length === 0 && <div className="sub org-empty">Noch keine Abteilungen oder Teams</div>}
                  {t.departments.map((d) => (
                    <div key={d.id} className="org-branch">
                      <div className="org-row">
                        <ChevronRight size={14} />
                        <Network size={15} />
                        <span className="org-name">{d.name}</span>
                        {d.description && <span className="sub">{d.description}</span>}
                        {t.current && edit && (
                          <span className="btn-row org-actions">
                            <button className="btn sm ghost" onClick={() => setDept(d)} aria-label={`${d.name} bearbeiten`}>
                              <Pencil size={14} />
                            </button>
                            <button className="btn sm ghost danger" onClick={() => removeDept(d)} aria-label={`${d.name} löschen`}>
                              <Trash2 size={14} />
                            </button>
                          </span>
                        )}
                      </div>
                      {d.teams.map((x) => (
                        <div key={x.id} className="org-leaf">
                          <TeamRow t={x} current={t.current} />
                        </div>
                      ))}
                      {d.teams.length === 0 && <div className="org-leaf sub">Keine Teams in dieser Abteilung</div>}
                    </div>
                  ))}
                  {t.teams.length > 0 && (
                    <div className="org-branch">
                      <div className="org-row sub">
                        <ChevronRight size={14} /> Ohne Abteilung
                      </div>
                      {t.teams.map((x) => (
                        <div key={x.id} className="org-leaf">
                          <TeamRow t={x} current={t.current} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        }
      </Loading>
      {(tenant || newTenant) && (
        <TenantForm
          tenant={tenant ?? {}}
          onClose={() => (setTenantEdit(null), onNewTenantClosed())}
          onSaved={() => {
            setTenantEdit(null);
            onNewTenantClosed();
            org.reload();
          }}
        />
      )}
      {dept && (
        <DepartmentEditor
          department={dept}
          onClose={() => setDept(null)}
          onSaved={() => {
            setDept(null);
            org.reload();
          }}
        />
      )}
      {team && (
        <TeamEditor
          team={team}
          users={users.data ?? []}
          departments={(org.data ?? []).find((t) => t.current)?.departments ?? []}
          onClose={() => setTeam(null)}
          onSaved={() => {
            setTeam(null);
            org.reload();
            teamList.reload?.();
          }}
        />
      )}
    </>
  );
}

export default function Organization() {
  const user = useUser();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead
        title="Organization"
        action={
          can(user, 'tenants.manage') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Neuer Mandant
            </button>
          )
        }
      >
        Mandant, Abteilung und Teams. Ein Mandant trennt alle Daten vollständig von anderen; Abteilungen gruppieren Teams.
      </PageHead>
      <Tree newTenant={creating} onNewTenantClosed={() => setCreating(false)} />
    </>
  );
}
