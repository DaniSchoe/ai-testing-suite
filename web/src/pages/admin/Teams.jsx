import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Card, initials, Modal, useApi } from '../../lib.jsx';

export default function Teams() {
  const teams = useApi('/api/teams');
  const users = useApi('/api/users');
  const [editing, setEditing] = useState(null);

  async function remove(t) {
    if (!confirm(`Team "${t.name}" löschen? Die User bleiben erhalten.`)) return;
    await api(`/api/teams/${t.id}`, { method: 'DELETE' });
    teams.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Teams</h1>
          <p>
            Teams bündeln User. Dashboard und Testergebnisse lassen sich nach Team filtern; Mitglieder sehen die Läufe ihres Teams auch ohne die
            Berechtigung „Alle Ergebnisse sehen“.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ members: [] })}>
          <Plus size={15} /> Neues Team
        </button>
      </div>
      {teams.data?.length === 0 && <div className="card empty">Noch keine Teams angelegt</div>}
      <div className="team-grid">
        {(teams.data ?? []).map((t) => (
          <Card
            key={t.id}
            title={t.name}
            sub={t.description || `${t.members.length} Mitglieder`}
            action={
              <span className="btn-row" style={{ flexWrap: 'nowrap' }}>
                <button className="btn sm ghost" onClick={() => setEditing(t)} aria-label={`${t.name} bearbeiten`}>
                  <Pencil size={14} />
                </button>
                <button className="btn sm ghost danger" onClick={() => remove(t)} aria-label={`${t.name} löschen`}>
                  <Trash2 size={14} />
                </button>
              </span>
            }
          >
            <div className="avatars">
              {t.members.map((m) => (
                <span key={m.id} className="avatar sm" title={m.display_name ?? m.username ?? m.email}>
                  {initials(m.display_name ?? m.username ?? m.email)}
                </span>
              ))}
              {t.members.length === 0 && <span className="sub">Noch keine Mitglieder</span>}
            </div>
            <div style={{ marginTop: 14, fontSize: 13 }}>
              <Link to={`/history?scope=team:${t.id}`}>Testergebnisse des Teams</Link>
            </div>
          </Card>
        ))}
      </div>
      {editing && (
        <TeamEditor
          team={editing}
          users={users.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            teams.reload();
          }}
        />
      )}
    </>
  );
}

function TeamEditor({ team, users, onClose, onSaved }) {
  const [form, setForm] = useState({ name: team.name ?? '', description: team.description ?? '' });
  const [memberIds, setMemberIds] = useState(() => new Set(team.members.map((m) => m.id)));
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);

  const visible = users.filter((u) => `${u.display_name ?? ''} ${u.username ?? ''} ${u.email ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  async function save() {
    try {
      await api(team.id ? `/api/teams/${team.id}` : '/api/teams', {
        method: team.id ? 'PUT' : 'POST',
        body: { ...form, memberIds: [...memberIds] },
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={team.id ? `Team ${team.name} bearbeiten` : 'Neues Team'}
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
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={form.name} placeholder="z. B. Data Science" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Beschreibung</span>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
      </div>
      <label className="field" style={{ marginBottom: 6 }}>
        <span>Mitglieder ({memberIds.size})</span>
        <input type="search" placeholder="User filtern…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <div className="pick-list">
        {visible.map((u) => (
          <label key={u.id}>
            <input
              type="checkbox"
              checked={memberIds.has(u.id)}
              onChange={() => {
                const next = new Set(memberIds);
                next.has(u.id) ? next.delete(u.id) : next.add(u.id);
                setMemberIds(next);
              }}
            />
            <span>
              <div style={{ fontWeight: 600 }}>{u.display_name ?? u.username ?? u.email}</div>
              <div className="sub">{u.email ?? u.username}</div>
            </span>
          </label>
        ))}
        {visible.length === 0 && <div className="empty">Keine User gefunden</div>}
      </div>
    </Modal>
  );
}
