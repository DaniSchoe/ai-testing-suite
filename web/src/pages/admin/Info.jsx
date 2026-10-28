import { Card, Loading, PageHead, useApi, useUser } from '../../lib.jsx';

const Row = ({ label, children }) => (
  <div className="meta-row">
    <span>{label}</span>
    <span>{children}</span>
  </div>
);

export default function Info() {
  const user = useUser();
  const info = useApi('/api/info');
  return (
    <>
      <PageHead title="Info">Version, Impressum und Support.</PageHead>
      <Card title="Anwendung">
        <Row label="Version">
          <span className="mono">{user.version}</span>
        </Row>
        <Row label="Anmeldung">{user.authMode === 'dev' ? 'Entwicklungsmodus (ohne Keycloak)' : 'Keycloak (OIDC)'}</Row>
        <Row label="Mandant">{user.tenant?.name}</Row>
      </Card>
      <Loading state={info}>
        {(d) => (
          <div className="two-col">
            {d.imprint && (
              <Card title="Impressum">
                {d.imprint.company && <Row label="Anbieter">{d.imprint.company}</Row>}
                {d.imprint.address && <Row label="Anschrift"><span style={{ whiteSpace: 'pre-line' }}>{d.imprint.address}</span></Row>}
                {d.imprint.represented_by && <Row label="Vertreten durch">{d.imprint.represented_by}</Row>}
                {d.imprint.email && <Row label="E-Mail"><a href={`mailto:${d.imprint.email}`}>{d.imprint.email}</a></Row>}
                {d.imprint.phone && <Row label="Telefon">{d.imprint.phone}</Row>}
                {d.imprint.register && <Row label="Register">{d.imprint.register}</Row>}
              </Card>
            )}
            {d.support && (
              <Card title="Support">
                {d.support.email && <Row label="E-Mail"><a href={`mailto:${d.support.email}`}>{d.support.email}</a></Row>}
                {d.support.phone && <Row label="Telefon">{d.support.phone}</Row>}
                {d.support.url && <Row label="Portal"><a href={d.support.url} target="_blank" rel="noreferrer">{d.support.url}</a></Row>}
                {d.support.hours && <Row label="Erreichbarkeit">{d.support.hours}</Row>}
              </Card>
            )}
          </div>
        )}
      </Loading>
    </>
  );
}
