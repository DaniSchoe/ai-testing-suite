import { useEffect, useState } from 'react';
import { api, Card, ErrorBox, Field, Loading, PageHead, useAction, useApi } from '../../lib.jsx';

const LABELS = { public: 'Öffentlich', internal: 'Intern', customer: 'Kundendaten', attack: 'Angriffsinhalte' };

export default function Archive() {
  const retention = useApi('/api/settings/retention');
  const [days, setDays] = useState(null);
  const [run, error, busy] = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (retention.data) setDays(retention.data.days);
  }, [retention.data]);
  const save = () =>
    run(async () => {
      await api('/api/settings/retention', { method: 'PUT', body: { days } });
      setSaved(true);
      retention.reload();
    });
  return (
    <>
      <PageHead title="Archivierung">Aufbewahrungsfristen für Nachweise. Gilt global für alle Mandanten.</PageHead>
      <ErrorBox error={error} />
      <Loading state={retention}>
        {(r) => (
          <Card
            title="Aufbewahrung von Nachweisen"
            sub="Nach Ablauf werden Prompt und Antwort gelöscht; Hash, Ergebnis und Zeitpunkt bleiben für die Nachweiskette erhalten. Die Frist richtet sich nach der Sensitivität des Datensatzes."
            action={
              <button className="btn sm primary" onClick={save} disabled={busy}>
                Speichern
              </button>
            }
          >
            <div className="form-grid">
              {Object.entries(LABELS).map(([k, label]) => (
                <Field key={k} label={`${label} (Tage)`} hint={`Standard ${r.defaults[k]}`}>
                  <input type="number" min={1} max={3650} value={days?.[k] ?? ''} onChange={(e) => (setSaved(false), setDays({ ...days, [k]: Number(e.target.value) }))} />
                </Field>
              ))}
            </div>
            {saved && <div className="hint">Gespeichert. Die Bereinigung läuft täglich.</div>}
          </Card>
        )}
      </Loading>
    </>
  );
}
