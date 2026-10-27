import { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { api, can, Empty, ErrorBox, Field, fmt, Loading, Modal, PageHead, Tabs, useAction, useApi, useUser } from '../lib.jsx';
import ApiKeys from './admin/ApiKeys.jsx';

export default function Credentials() {
  const user = useUser();
  const [tab, setTab] = useState('keys');
  const tokenAdmin = can(user, 'users.manage');
  return (
    <>
      <PageHead title="Keys">API-Keys für Gateways und Service-Tokens für CI/CD und die Kommandozeile.</PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[['keys', 'API-Keys'], ...(tokenAdmin ? [['tokens', 'Service-Tokens']] : [])]}
      />
      {tab === 'keys' && <ApiKeys />}
      {tab === 'tokens' && <ServiceTokens />}
    </>
  );
}

function ServiceTokens() {
  const list = useApi('/api/service-tokens');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [run, error, busy] = useAction();
  const create = () =>
    run(async () => {
      const res = await api('/api/service-tokens', { method: 'POST', body: { name, expires_in_days: days || undefined } });
      setCreating(false);
      setName('');
      setDays('');
      setCreated(res.token);
      list.reload();
    });
  const revoke = (t) =>
    confirm(`Token „${t.name}“ widerrufen? Pipelines mit diesem Token verlieren sofort den Zugriff.`) &&
    run(async () => {
      await api(`/api/service-tokens/${t.id}`, { method: 'DELETE' });
      list.reload();
    });
  return (
    <>
      <div className="toolbar">
        <span className="hint" style={{ flex: 1 }}>
          Ein Service-Token (<span className="mono">sat_…</span>) gilt für einen Mandanten und darf Prüfungen starten und Ergebnisse lesen, sonst nichts. Verwendung: <span className="mono">SAT_TOKEN=… node tools/cli.js run &quot;Prüfung&quot; --wait</span>
        </span>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> Neues Token
        </button>
      </div>
      <ErrorBox error={error} />
      <Loading state={list}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>Keine Service-Tokens.</Empty>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Präfix</th>
                    <th>Angelegt</th>
                    <th>Zuletzt genutzt</th>
                    <th>Läuft ab</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.name}
                        {t.revoked_at && <span className="badge failed" style={{ marginLeft: 6 }}>widerrufen</span>}
                        <div className="sub">{t.created_by_name}</div>
                      </td>
                      <td className="mono">{t.prefix}…</td>
                      <td className="sub">{fmt.date(t.created_at)}</td>
                      <td className="sub">{t.last_used_at ? fmt.ago(t.last_used_at) : 'nie'}</td>
                      <td className="sub">{t.expires_at ? fmt.date(t.expires_at) : 'nie'}</td>
                      <td className="num">
                        {!t.revoked_at && (
                          <button className="btn sm ghost danger" onClick={() => revoke(t)} disabled={busy} aria-label="Widerrufen">
                            <Trash2 size={14} />
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
      </Loading>
      {creating && (
        <Modal
          title="Neues Service-Token"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                Abbrechen
              </button>
              <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>
                Erstellen
              </button>
            </>
          }
        >
          <Field label="Name (z. B. die Pipeline)">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Gültigkeit in Tagen (leer = unbegrenzt)">
            <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </Modal>
      )}
      {created && (
        <Modal
          title="Token kopieren"
          onClose={() => setCreated(null)}
          footer={
            <button className="btn primary" onClick={() => setCreated(null)}>
              Fertig
            </button>
          }
        >
          <div className="hint">Dieses Token wird nur jetzt angezeigt. Speichere es als Secret deiner Pipeline.</div>
          <pre className="code-block" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{created}</pre>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(created)}>
            <Copy size={14} /> Kopieren
          </button>
        </Modal>
      )}
    </>
  );
}
