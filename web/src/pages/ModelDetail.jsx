import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { Card, EnvBadge, KindBadge, useApi } from '../lib.jsx';

// Platzhalter: hier entstehen später weitere Auswertungen je Modell (Beta).
export default function ModelDetail() {
  const { name } = useParams();
  const models = useApi('/api/models');
  const rows = (models.data ?? []).filter((m) => (m.alias ?? m.name) === name);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {name} <span className="badge warn">Beta</span>
          </h1>
          <p>Detailseite für dieses Modell. Die Auswertungen hier sind noch ein Platzhalter.</p>
        </div>
        <Link className="btn" to="/">
          <ArrowLeft size={15} /> Zum Dashboard
        </Link>
      </div>
      <div className="two-col">
        <Card title="Angeboten über">
          {rows.length === 0 && <div className="empty">Modell nicht im Katalog gefunden</div>}
          {rows.map((m) => (
            <div key={`${m.endpoint_id}:${m.name}`} className="meta-row">
              <div>
                {m.endpoint_name} <KindBadge kind={m.endpoint_kind} />
              </div>
              <div>
                <code>{m.name}</code> <EnvBadge env={m.effective_environment} />
                {m.maintainer_name && <div className="sub">Maintainer: {m.maintainer_name}</div>}
              </div>
            </div>
          ))}
          <p className="sub" style={{ marginTop: 12 }}>
            Bearbeiten lässt sich das Modell im <Link to="/admin/models">Modellkatalog</Link>.
          </p>
        </Card>
        <Card title="Weitere Auswertungen">
          <div className="empty" style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
            <FlaskConical size={28} />
            <div>Hier folgen Verläufe, Vergleiche und Kennzahlen für dieses Modell.</div>
            <div className="sub">Beta-Funktion, vorerst nur ein Platzhalter</div>
          </div>
        </Card>
      </div>
    </>
  );
}
