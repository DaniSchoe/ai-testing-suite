import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, fmt, useApi } from '../../lib.jsx';

// Modellkatalog: alle per /v1/models gefundenen Modelle. Der Alias führt gleiche Modelle mit
// unterschiedlichen Namen zusammen (z. B. "Qwen/Qwen3-32B" am vLLM-Endpunkt und "qwen3-32b" in LiteLLM).
export default function Models() {
  const models = useApi('/api/models');
  const endpoints = useApi('/api/endpoints');
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState(null);

  const groups = useMemo(() => {
    const map = new Map();
    for (const m of models.data ?? []) {
      const key = m.alias ?? m.name;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    return [...map.entries()];
  }, [models.data]);

  async function syncAll() {
    setSyncing(true);
    setMessage(null);
    const targets = (endpoints.data ?? []).filter((e) => e.kind !== 'mcp' && e.enabled);
    const results = await Promise.all(
      targets.map((e) =>
        api(`/api/endpoints/${e.id}/sync-models`, { method: 'POST' })
          .then((r) => ({ name: e.name, ...r }))
          .catch((err) => ({ name: e.name, ok: false, error: err.message })),
      ),
    );
    const failed = results.filter((r) => !r.ok);
    setMessage(failed.length ? `Abruf fehlgeschlagen für: ${failed.map((f) => f.name).join(', ')}` : `${targets.length} Endpoints abgefragt`);
    setSyncing(false);
    models.reload();
    endpoints.reload();
  }

  async function saveAlias(m, alias) {
    if ((alias || null) === (m.alias || null)) return;
    await api('/api/endpoint-models', { method: 'PUT', body: { endpoint_id: m.endpoint_id, name: m.name, alias } });
    models.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Modellkatalog</h1>
          <p>
            Modelle aller Endpoints, automatisch über /v1/models abgefragt. Vergib einen gemeinsamen Alias, wenn dasselbe Modell in vLLM und LiteLLM
            unterschiedlich heißt. Tests und Dashboard verwenden den Alias.
          </p>
        </div>
        <button className="btn primary" onClick={syncAll} disabled={syncing}>
          <RefreshCw size={15} /> {syncing ? 'Frage ab…' : 'Alle Modelle abfragen'}
        </button>
      </div>
      {message && <div className="error-box" style={{ background: 'var(--primary-soft)', color: 'var(--primary-text)' }}>{message}</div>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Alias</th>
              <th>Endpoint</th>
              <th>Name am Endpoint</th>
              <th>Status</th>
              <th className="num">Zuletzt gesehen</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([alias, rows]) =>
              rows.map((m, i) => (
                <tr key={`${m.endpoint_id}:${m.name}`} style={i === 0 ? undefined : { borderTop: 0 }}>
                  <td style={{ width: 240 }}>
                    <input
                      defaultValue={m.alias ?? ''}
                      placeholder={m.name}
                      aria-label={`Alias für ${m.name}`}
                      onBlur={(e) => saveAlias(m, e.target.value.trim())}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                    {i === 0 && rows.length > 1 && <div className="sub">{rows.length} Endpoints bieten „{alias}“ an</div>}
                  </td>
                  <td>
                    {m.endpoint_name} <span className="tag">{m.endpoint_kind}</span>
                  </td>
                  <td>
                    <code>{m.name}</code>
                    {m.source === 'manual' && <div className="sub">manuell eingetragen</div>}
                  </td>
                  <td>
                    {m.available ? <span className="badge passed">✓ verfügbar</span> : <span className="badge warn">– nicht mehr gelistet</span>}
                  </td>
                  <td className="num sub">{m.source === 'manual' ? '–' : fmt.ago(m.last_seen_at)}</td>
                </tr>
              )),
            )}
            {models.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Noch keine Modelle. Lege Endpoints an und frage die Modelle ab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
