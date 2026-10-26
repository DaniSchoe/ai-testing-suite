import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, fmt, scopeParams, useApi } from '../lib.jsx';
import { PROFILE_AXES } from '../modelProfile.js';

// Detailseite zum Modellprofil: dieselben Kategorien wie das Netzdiagramm im Dashboard, als Tabelle.
// Zeitraum und Filter kommen als URL-Parameter vom Dashboard.
export default function ModelProfiles() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scope = params.get('scope') ?? 'all';
  const query = new URLSearchParams({ ...scopeParams(scope), days: params.get('days') ?? '30' });
  for (const k of ['models', 'endpoints']) if (params.get(k)) query.set(k, params.get(k));
  const { data, error } = useApi(`/api/dashboard?${query}`, { interval: 15000 });
  if (error) return <div className="error-box">{error}</div>;
  const profiles = data?.profiles ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Modellprofil im Detail</h1>
          <p>Letzte {data?.days ?? params.get('days') ?? 30} Tage. Gleiche Kategorien wie das Netzdiagramm; ein Klick öffnet die Modelldetails (Beta).</p>
        </div>
        <Link className="btn" to="/">
          <ArrowLeft size={15} /> Zum Dashboard
        </Link>
      </div>
      <Card title="Modelle im Vergleich" sub="Rohwerte je Modell, Mittelwert über alle Tests im Zeitraum" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Modell</th>
                <th className="num">Erfolgsquote</th>
                {PROFILE_AXES.map((a) => (
                  <th key={a.key} className="num">
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profiles.map((m) => (
                <tr key={m.model} className="clickable" onClick={() => navigate(`/models/${encodeURIComponent(m.model)}`)}>
                  <td>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m.model}</div>
                    <div className="sub">
                      {m.runs} Läufe{m.endpoints > 1 ? ` · über ${m.endpoints} Endpoints` : ''}
                    </div>
                  </td>
                  <td className="num">{fmt.pct(m.pass_rate)}</td>
                  {PROFILE_AXES.map((a) => (
                    <td key={a.key} className="num">
                      {a.display(m)}
                    </td>
                  ))}
                </tr>
              ))}
              {!profiles.length && (
                <tr>
                  <td colSpan={2 + PROFILE_AXES.length} className="empty">
                    Keine Modelldaten im Zeitraum
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
