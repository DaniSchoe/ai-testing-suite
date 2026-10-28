import { Link } from 'react-router-dom';
import { can, EnvBadge, getPlatform, Loading, PageHead, useApi, useUser } from '../lib.jsx';
import { SovereigntyGoals } from '../components/Assessment.jsx';

// Souveränität der gewählten Plattform; erreichbar über die Kachel im Dashboard.
export default function Sovereignty() {
  const user = useUser();
  const id = getPlatform();
  const data = useApi(id ? `/api/platforms/${id}/assessment` : null);
  return (
    <>
      <PageHead title="Souveränität">
        Bewertung entlang der Souveränitätsziele SOV-1 bis SOV-8 mit Stufen SEAL-0 bis SEAL-4. Sie ergibt sich aus der angelegten Plattform, dem Modellportfolio und den Tests. Einzelne Ziele lassen sich mit Begründung überschreiben.
      </PageHead>
      {!id && <div className="empty">Keine Plattform gewählt.</div>}
      {id && (
        <Loading state={data}>
          {(d) => (
            <>
              <div style={{ marginBottom: 12 }}>
                <Link to={`/platforms/${d.platform.id}?tab=assessment`}>{d.platform.name}</Link> <EnvBadge env={d.platform.environment} />
              </div>
              <SovereigntyGoals defaultOpen data={d} editable={can(user, 'endpoints.manage')} onChanged={data.reload} />
            </>
          )}
        </Loading>
      )}
    </>
  );
}
