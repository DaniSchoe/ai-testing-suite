import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { api, Card, ErrorBox, fmt, KIND_META, Loading, PageHead, useAction, useApi } from '../../lib.jsx';
import { Check, Text } from './Components.jsx';

function Form({ data, reload }) {
  const [form, setForm] = useState(data.settings);
  const [view, setView] = useState(data);
  const [run, error, busy] = useAction();
  useEffect(() => setView(data), [data]);
  const save = () =>
    run(async () => {
      setView(await api('/api/settings/metrics', { method: 'PUT', body: form }));
    });
  const check = () =>
    run(async () => {
      setView(await api('/api/settings/metrics/check', { method: 'POST' }));
    });
  const recent = (e) => e.last_sample_at && Date.now() - new Date(e.last_sample_at) < Math.max(form.interval_s * 3000, 120000);
  return (
    <>
      <ErrorBox error={error} />
      <Card title="Darstellung und Sammlung" sub="Gilt für alle Metriken-Dashboards.">
        <Check checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })}>
          Metriken sammeln und anzeigen
        </Check>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Text label="Abfrageintervall (Sekunden)" type="number" min={10} max={600} value={form.interval_s} onChange={(v) => setForm({ ...form, interval_s: Number(v) })} hint="10 bis 600 Sekunden." />
          <Text label="Aufbewahrung (Stunden)" type="number" min={1} max={168} value={form.retention_h} onChange={(v) => setForm({ ...form, retention_h: Number(v) })} hint="Ältere Messpunkte werden gelöscht (1 bis 168 Stunden)." />
        </div>
        <button className="btn primary" onClick={save} disabled={busy}>
          Speichern
        </button>
      </Card>
      <Card
        title="Metrics-Endpunkte"
        sub="Zustand aller Komponenten mit Metrics-Endpunkt."
        action={
          <button className="btn sm" onClick={check} disabled={busy}>
            <PlugZap size={13} /> Jetzt prüfen
          </button>
        }
        flush
      >
        <table>
          <thead>
            <tr>
              <th>Komponente</th>
              <th>Art</th>
              <th>Endpunkt</th>
              <th>Status</th>
              <th>Letzter Messpunkt</th>
              <th className="num">Messpunkte</th>
            </tr>
          </thead>
          <tbody>
            {view.endpoints.map((e) => {
              const ok = e.state ? e.state.ok : recent(e) ? true : null;
              return (
                <tr key={e.id}>
                  <td>
                    {e.name}
                    <div className="sub">{e.platform_name}</div>
                  </td>
                  <td>{KIND_META[e.kind]?.label ?? e.kind}</td>
                  <td className="mono sub">{e.url}</td>
                  <td>
                    {ok === null ? <span className="sub">nicht geprüft</span> : <span className={`badge ${ok ? 'passed' : 'failed'}`}>{ok ? 'erreichbar' : 'gestört'}</span>}
                    {e.state && !e.state.ok && <div className="sub">{e.state.error}</div>}
                  </td>
                  <td className="sub">{e.last_sample_at ? fmt.ago(e.last_sample_at) : '–'}</td>
                  <td className="num">{e.samples}</td>
                </tr>
              );
            })}
            {view.endpoints.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  Keine Komponente mit Metrics-Endpunkt. Trage ihn an GPU, Inferenzserver oder AI Gateway unter „Optionale Angaben“ ein.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

export default function MetricsSettings() {
  const data = useApi('/api/settings/metrics');
  return (
    <>
      <PageHead title="Metriken">Einstellungen für die Metriken-Dashboards (Beta) und der Zustand aller Metrics-Endpunkte.</PageHead>
      <Loading state={data}>{(d) => <Form data={d} reload={data.reload} />}</Loading>
    </>
  );
}
