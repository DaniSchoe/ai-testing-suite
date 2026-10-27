import { Card, PageHead, useUser } from '../../lib.jsx';

export default function Info() {
  const user = useUser();
  return (
    <>
      <PageHead title="Info">Version und Betriebsart der Anwendung.</PageHead>
      <Card title="Anwendung">
        <div className="meta-row">
          <span>Version</span>
          <span className="mono">{user.version}</span>
        </div>
        <div className="meta-row">
          <span>Anmeldung</span>
          <span>{user.authMode === 'dev' ? 'Entwicklungsmodus (ohne Keycloak)' : 'Keycloak (OIDC)'}</span>
        </div>
        <div className="meta-row">
          <span>Mandant</span>
          <span>{user.tenant?.name}</span>
        </div>
      </Card>
    </>
  );
}
