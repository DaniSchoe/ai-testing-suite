import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, PageHead, useApi } from '../../lib.jsx';

// Modell, das nach jedem Testlauf die KI-Analyse erstellt (eine Einstellung für die ganze Anwendung, nur für Administratoren).
export default function AnalysisSettings() {
  const models = useApi('/api/models');
  const current = useApi('/api/settings/analysis');
  const [error, setError] = useState(null);
  const options = (models.data ?? []).filter((m) => m.available && m.endpoint_kind !== 'mcp');
  const value = current.data?.endpoint_id ? `${current.data.endpoint_id}|${current.data.model}` : '';

  async function change(v) {
    setError(null);
    const [endpoint_id, ...rest] = v.split('|');
    try {
      await api('/api/settings/analysis', { method: 'PUT', body: v ? { endpoint_id, model: rest.join('|') } : {} });
      current.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <PageHead title="KI-Analyse">Modell, das nach jedem Testlauf die Ergebnisse bewertet, in Kontext setzt und zusammenfasst. Ohne Auswahl gibt es keine Analyse.</PageHead>
      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="icon-chip">
            <Sparkles size={16} />
          </span>
          <div style={{ flex: '1 1 320px', fontWeight: 600 }}>Modell für die KI-Analyse</div>
          <select className="inline" value={value} onChange={(e) => change(e.target.value)} aria-label="Analysemodell" style={{ minWidth: 260 }}>
            <option value="">– keine Analyse –</option>
            {options.map((m) => (
              <option key={`${m.endpoint_id}|${m.name}`} value={`${m.endpoint_id}|${m.name}`}>
                {m.alias ?? m.name} · {m.endpoint_name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="error-box" style={{ margin: '0 16px 16px' }}>{error}</div>}
      </div>
    </>
  );
}
