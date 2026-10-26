import { useState } from 'react';
import { Empty, Field, useApi } from '../lib.jsx';
import SizingView from './SizingView.jsx';

// Sizing gehört zur Plattform: Auswahl oben, darunter Konfiguration, Live-Werte und Messungen dieser Plattform.
export default function Sizing() {
  const platforms = useApi('/api/platforms');
  const [id, setId] = useState(() => {
    try {
      return localStorage.getItem('sizing-platform') || '';
    } catch {
      return '';
    }
  });
  const list = platforms.data ?? [];
  const current = list.find((p) => p.id === id) ?? list[0];
  return (
    <>
      <div style={{ maxWidth: 360, marginBottom: 12 }}>
        <Field label="Plattform">
          <select
            value={current?.id ?? ''}
            onChange={(e) => {
              setId(e.target.value);
              try {
                localStorage.setItem('sizing-platform', e.target.value);
              } catch {
                /* Speicher nicht verfügbar */
              }
            }}
          >
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.environment})
              </option>
            ))}
          </select>
        </Field>
      </div>
      {current ? <SizingView key={current.id} platformId={current.id} /> : <Empty>Noch keine Plattform.</Empty>}
    </>
  );
}
