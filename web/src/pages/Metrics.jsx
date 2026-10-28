import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { TrendLines } from '../components/Charts.jsx';
import { can, Card, Empty, getPlatform, Loading, PageHead, Tabs, useApi, useUser } from '../lib.jsx';

const clock = (d) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const n1 = (v) => (v === null || v === undefined ? '–' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v));

// Dashboards je Komponentenart: Titel, Einheit und die Werte aus der abgeleiteten Zeitreihe.
const GROUPS = {
  inference: {
    label: 'vLLM',
    tiles: [['running', 'Laufende Anfragen'], ['waiting', 'Wartende Anfragen'], ['kv_cache_pct', 'KV-Cache %'], ['generation_tokens_per_s', 'Token/s (Ausgabe)'], ['ttft_ms', 'TTFT ms'], ['prefix_hit_pct', 'Prefix-Cache-Treffer %']],
    panels: [
      ['Anfragen', ['running', 'waiting'], { running: 'laufend', waiting: 'wartend' }],
      ['KV-Cache-Auslastung (%)', ['kv_cache_pct'], { kv_cache_pct: 'KV-Cache' }],
      ['Durchsatz (Token/s)', ['generation_tokens_per_s', 'prompt_tokens_per_s'], { generation_tokens_per_s: 'Ausgabe', prompt_tokens_per_s: 'Eingabe' }],
      ['Latenz (ms)', ['ttft_ms', 'e2e_ms'], { ttft_ms: 'TTFT', e2e_ms: 'Gesamt' }],
      ['Zwischen-Token-Latenz und Wartezeit (ms)', ['itl_ms', 'queue_ms'], { itl_ms: 'je Token', queue_ms: 'Warteschlange' }],
    ],
  },
  gateway: {
    label: 'LiteLLM',
    tiles: [['requests_per_s', 'Anfragen/s'], ['failed_per_s', 'Fehler/s'], ['error_pct', 'Fehlerquote %'], ['tokens_per_s', 'Token/s'], ['latency_ms', 'Latenz ms']],
    panels: [
      ['Anfragen pro Sekunde', ['requests_per_s', 'failed_per_s'], { requests_per_s: 'gesamt', failed_per_s: 'fehlgeschlagen' }],
      ['Fehlerquote (%)', ['error_pct'], { error_pct: 'Fehlerquote' }],
      ['Durchsatz (Token/s)', ['tokens_per_s'], { tokens_per_s: 'Token/s' }],
      ['Latenz (ms)', ['latency_ms'], { latency_ms: 'Latenz' }],
    ],
  },
  gpu: {
    label: 'DCGM (GPU)',
    tiles: [['gpus', 'GPUs'], ['util_pct', 'Auslastung %'], ['mem_used_gib', 'Speicher GiB'], ['power_w', 'Leistung W'], ['temp_c_max', 'Temperatur °C']],
    panels: [
      ['GPU-Auslastung (%)', ['util_pct', 'mem_copy_util_pct'], { util_pct: 'GPU', mem_copy_util_pct: 'Speicher-Kopie' }],
      ['Speicher (GiB)', ['mem_used_gib', 'mem_total_gib'], { mem_used_gib: 'belegt', mem_total_gib: 'gesamt' }],
      ['Leistungsaufnahme (W)', ['power_w'], { power_w: 'Leistung' }],
      ['Temperatur (°C, Maximum)', ['temp_c_max'], { temp_c_max: 'Temperatur' }],
    ],
  },
};

function ComponentDashboard({ c, spec }) {
  const rows = c.series.map((p) => ({ day: p.at, ...p.v }));
  const state = c.state;
  return (
    <Card
      title={c.name}
      sub={`${c.platform_name} · ${state ? (state.ok ? 'Endpunkt erreichbar' : `Endpunkt nicht erreichbar: ${state.error}`) : 'noch nicht abgefragt'}`}
    >
      <div className="tile-grid metric-tiles">
        {spec.tiles.map(([key, label]) => (
          <div key={key} className="tile static">
            <div className="sub">{label}</div>
            <h3>{n1(c.latest?.[key])}</h3>
          </div>
        ))}
      </div>
      {rows.length < 2 ? (
        <Empty>Noch zu wenige Messpunkte. Die Werte werden im eingestellten Intervall gesammelt.</Empty>
      ) : (
        <div className="two-col">
          {spec.panels.map(([title, keys, names]) => (
            <div key={title}>
              <div className="sub" style={{ fontWeight: 600 }}>
                {title}
              </div>
              <TrendLines
                data={rows.map((r) => Object.fromEntries([['day', r.day], ...keys.map((k) => [names[k], r[k] ?? null])]))}
                keys={keys.map((k) => names[k])}
                valueFormatter={n1}
                xFormatter={clock}
                height={190}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function Metrics() {
  const user = useUser();
  const [tab, setTab] = useState('inference');
  const [minutes, setMinutes] = useState(60);
  const platformId = getPlatform();
  const data = useApi(`/api/metrics?minutes=${minutes}${platformId ? `&platform_id=${platformId}` : ''}`, { interval: 30000 });
  return (
    <>
      <PageHead
        title={
          <>
            Metriken <span className="tag">Beta</span>
          </>
        }
        action={
          can(user, 'settings.manage') && (
            <Link className="btn" to="/admin/metrics">
              <Settings size={15} /> Einstellungen
            </Link>
          )
        }
      >
        Live-Werte aus den Metrics-Endpunkten der Komponenten. Den Endpunkt trägst du an der Komponente ein.
      </PageHead>
      <div className="toolbar">
        <Tabs value={tab} onChange={setTab} tabs={Object.entries(GROUPS).map(([k, g]) => [k, g.label])} />
        <span style={{ flex: 1 }} />
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Zeitraum">
          <option value={15}>letzte 15 Minuten</option>
          <option value={60}>letzte Stunde</option>
          <option value={360}>letzte 6 Stunden</option>
          <option value={1440}>letzte 24 Stunden</option>
        </select>
      </div>
      <Loading state={data}>
        {(d) => {
          const list = d.components.filter((c) => c.group === tab);
          return (
            <>
              {!d.enabled && <div className="error-box">Die Sammlung der Metriken ist in den Einstellungen ausgeschaltet.</div>}
              {list.length === 0 ? (
                <Empty>Keine Komponente mit Metrics-Endpunkt für {GROUPS[tab].label}. Trage ihn an der Komponente unter „Optionale Angaben“ ein.</Empty>
              ) : (
                list.map((c) => <ComponentDashboard key={c.id} c={c} spec={GROUPS[tab]} />)
              )}
            </>
          );
        }}
      </Loading>
    </>
  );
}
