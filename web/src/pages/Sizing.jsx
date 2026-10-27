import { Empty, getPlatform, useApi } from '../lib.jsx';
import SizingView from './SizingView.jsx';

// Sizing gehört zur Plattform: Konfiguration, Live-Werte und Messungen der oben gewählten Plattform. Beta.
export default function Sizing() {
  const platforms = useApi('/api/platforms');
  const list = platforms.data ?? [];
  const current = list.find((p) => p.id === getPlatform()) ?? list[0];
  return (
    <>
      <div className="hint" style={{ marginBottom: 12 }}>
        <span className="tag nav-tag">Beta</span> Das Sizing befindet sich in der Erprobung; Ergebnisse sind Richtwerte.
      </div>
      {current ? <SizingView key={current.id} platformId={current.id} /> : <Empty>Noch keine Plattform.</Empty>}
    </>
  );
}
