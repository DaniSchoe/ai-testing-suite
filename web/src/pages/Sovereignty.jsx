import { Link } from 'react-router-dom';
import { Card, Empty, EnvBadge, envParam, Loading, PageHead, useApi } from '../lib.jsx';

const STATUS = { ok: ['passed', 'erfüllt'], below: ['failed', 'unter Mindeststufe'], unrated: ['queued', 'nicht bewertet'] };

export default function Sovereignty() {
  const data = useApi(`/api/sovereignty${envParam()}`);
  return (
    <>
      <PageHead title="Souveränität">
        Bewertung je Plattform entlang der Souveränitätsziele SOV-1 bis SOV-8 mit Stufen SEAL-0 bis SEAL-4. Wirksam ist das Minimum aus der Erklärung der Plattform und dem, was Prüfungen messen. Messwerte können eine Erklärung nur absenken.
      </PageHead>
      <Loading state={data}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Keine Plattformen.</Empty>
          ) : (
            list.map((s) => (
              <Card
                key={s.platform.id}
                title={
                  <>
                    <Link to={`/platforms/${s.platform.id}`}>{s.platform.name}</Link> <EnvBadge env={s.platform.environment} />
                  </>
                }
                sub={`Gesamt: ${s.overall != null ? `SEAL-${s.overall}` : 'nicht bewertet'} · geforderte Mindeststufe SEAL-${s.min_level}`}
                flush
              >
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Ziel</th>
                        <th className="num">Erklärt</th>
                        <th className="num">Gemessen</th>
                        <th className="num">Wirksam</th>
                        <th>Stand</th>
                        <th>Begründung</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.goals.map((g) => {
                        const [cls, text] = STATUS[g.status] ?? ['queued', g.status];
                        return (
                          <tr key={g.key}>
                            <td>
                              {g.key} <span className="sub">{g.name}</span>
                            </td>
                            <td className="num">{g.declared ?? '–'}</td>
                            <td className="num" title={g.tests ? `${g.passed} von ${g.tests} bestanden` : undefined}>
                              {g.derived ?? '–'}
                            </td>
                            <td className="num">
                              <strong>{g.effective ?? '–'}</strong>
                            </td>
                            <td>
                              <span className={`badge ${cls}`}>{text}</span>
                            </td>
                            <td className="sub">{g.note}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))
          )
        }
      </Loading>
      <div className="hint">Stufen aus der Bestehensquote: ab 95 % SEAL-4, ab 80 % SEAL-3, ab 60 % SEAL-2, ab 30 % SEAL-1, darunter SEAL-0. Die Erklärung pflegst du an der Plattform.</div>
    </>
  );
}
