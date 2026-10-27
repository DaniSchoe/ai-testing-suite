// Diagramme im Stil der Vorlage: dünne Marken, dezente Achsen, Tooltip bei Hover, Legende ab zwei Reihen.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { fmt } from '../lib.jsx';

export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);

function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{labelFormatter ? labelFormatter(label) : label}</div>
      {payload.map((p) => (
        <div className="row" key={p.dataKey}>
          <span>
            <i className="swatch" style={{ background: p.color }} /> {p.name}
          </span>
          <strong>{valueFormatter ? valueFormatter(p.value) : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <i style={{ background: it.color }} /> {it.label}
        </span>
      ))}
    </div>
  );
}

const axis = { stroke: 'var(--axis)', fontSize: 12, tickLine: false, axisLine: false };

// Säulen pro Tag; mit mehreren Reihen gestapelt (z. B. bestanden / fehlgeschlagen / Fehler).
export function DailyBars({ data, series, height = 240 }) {
  return (
    <>
      <Legend items={series} />
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="day" tickFormatter={fmt.day} {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip cursor={{ fill: 'var(--surface-hover)' }} content={<ChartTooltip labelFormatter={(d) => fmt.day(d)} />} />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="a"
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={1}
                radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
                maxBarSize={44}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

// Einfache Balken je Kategorie. data: [{ name, value }], eine Farbe je Balken (series-Palette), Einheit im Tooltip.
export function ValueBars({ data, unit = '', height = 220, colors }) {
  const fmtVal = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 10) / 10}${unit}`);
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="name" {...axis} interval={0} />
          <YAxis {...axis} width={48} />
          <Tooltip cursor={{ fill: 'var(--surface-hover)' }} content={<ChartTooltip valueFormatter={fmtVal} />} />
          <Bar dataKey="value" name="Wert" maxBarSize={56} radius={[4, 4, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={d.name} fill={colors?.[i] ?? SERIES[i % SERIES.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Zeitreihe je Modell (z. B. TTFT p95). data: [{ day, [model]: value }]
export function TrendLines({ data, keys, valueFormatter, height = 240 }) {
  const items = keys.map((k, i) => ({ label: k, color: SERIES[i % SERIES.length] }));
  return (
    <>
      <Legend items={items} />
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="day" tickFormatter={fmt.day} {...axis} />
            <YAxis tickFormatter={valueFormatter} {...axis} width={60} />
            <Tooltip
              cursor={{ stroke: 'var(--axis)', strokeDasharray: '3 3' }}
              content={<ChartTooltip labelFormatter={(d) => fmt.day(d)} valueFormatter={valueFormatter} />}
            />
            {keys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                name={k}
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 2, fill: 'var(--surface)' }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

// Fortschrittsbalken wie "Pipeline nach Phase".
export function ProgressList({ rows }) {
  return rows.map((r) => (
    <div className="progress-row" key={r.label}>
      <div className="progress-label">
        <span>
          {r.label} <span className="muted">· {r.count}</span>
        </span>
        <strong>{r.valueLabel}</strong>
      </div>
      <div className="track" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={r.value} aria-label={r.label}>
        <span style={{ width: `${Math.max(0, Math.min(1, r.value ?? 0)) * 100}%` }} />
      </div>
    </div>
  ));
}

// Halbkreis-Gauge für einen Anteil von 0 bis 1 (z. B. Genauigkeit/Qualität). Farbe nach Schwellen.
export function Gauge({ value, label, sub }) {
  const has = value !== null && value !== undefined;
  const v = has ? Math.max(0, Math.min(1, Number(value))) : 0;
  const color = !has ? 'var(--axis)' : v >= 0.8 ? 'var(--ok, #1a9b5f)' : v >= 0.6 ? 'var(--warn, #c77d12)' : 'var(--bad, #dc2626)';
  const r = 80;
  const c = Math.PI * r; // Länge des Halbkreises
  const arc = `M 20 100 A ${r} ${r} 0 0 1 180 100`;
  return (
    <div className="gauge" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%' }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <svg viewBox="0 0 200 118" width="100%" style={{ maxWidth: 280, display: 'block', margin: '0 auto' }}>
        <path d={arc} fill="none" stroke="var(--grid)" strokeWidth="16" strokeLinecap="round" />
        {has && <path d={arc} fill="none" stroke={color} strokeWidth="16" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} />}
        <text x="100" y="92" textAnchor="middle" fontSize="30" fontWeight="700" fill="var(--text)">
          {has ? fmt.pct(v) : '–'}
        </text>
        <text x="20" y="116" textAnchor="middle" fontSize="10" fill="var(--axis)">
          0
        </text>
        <text x="180" y="116" textAnchor="middle" fontSize="10" fill="var(--axis)">
          100 %
        </text>
      </svg>
      {sub && <div className="sub" style={{ textAlign: 'center' }}>{sub}</div>}
    </div>
  );
}

// Lasttests: Antwortzeit (p95) im Verhältnis zu parallelen Anfragen, eine Reihe je Modell.
export function LoadScatter({ points, height = 260 }) {
  const models = [...new Set(points.map((p) => p.model))];
  const items = models.map((m, i) => ({ label: m, color: SERIES[i % SERIES.length] }));
  return (
    <>
      <Legend items={items} />
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 12, left: -4, bottom: 18 }}>
            <CartesianGrid stroke="var(--grid)" />
            <XAxis type="number" dataKey="concurrency" name="Parallele Anfragen" {...axis} label={{ value: 'Parallele Anfragen', position: 'insideBottom', offset: -10, fill: 'var(--axis)', fontSize: 12 }} allowDecimals={false} />
            <YAxis type="number" dataKey="latency_ms_p95" name="Antwortzeit p95" tickFormatter={fmt.ms} {...axis} width={64} />
            <ZAxis range={[60, 60]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className="chart-tooltip">
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{payload[0].payload.model}</div>
                    <div className="row">
                      <span>Parallel</span>
                      <strong>{payload[0].payload.concurrency}</strong>
                    </div>
                    <div className="row">
                      <span>p95</span>
                      <strong>{fmt.ms(payload[0].payload.latency_ms_p95)}</strong>
                    </div>
                    <div className="row">
                      <span>Fehlerquote</span>
                      <strong>{fmt.pct(payload[0].payload.error_rate)}</strong>
                    </div>
                  </div>
                ) : null
              }
            />
            {models.map((m, i) => (
              <Scatter key={m} name={m} data={points.filter((p) => p.model === m)} fill={SERIES[i % SERIES.length]} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

// Achsenbeschriftung mit Zeilenumbruch vor der Klammer ("Last-Performance" / "(Stabilität)").
function AxisTick({ x, y, payload, textAnchor }) {
  const lines = String(payload.value).split(/ (?=\()/);
  return (
    <text x={x} y={y} textAnchor={textAnchor} fill="var(--text-2)" fontSize={12}>
      {lines.map((l, i) => (
        <tspan key={l} x={x} dy={i === 0 ? 0 : 14}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

// Netzdiagramm: ein Polygon je Modell, Achsen mit Werten von 0 bis 100 (höher ist besser); Rohwerte stehen im Tooltip.
// series: [{ name, axes: [{ label, value, display, missing }] }]
export function RadarProfile({ series, height = 340 }) {
  const labels = series[0]?.axes.map((a) => a.label) ?? [];
  const data = labels.map((label, i) => {
    const row = { label };
    series.forEach((s, j) => {
      row[`v${j}`] = s.axes[i].value;
    });
    return row;
  });
  const items = series.map((s, j) => ({ label: s.name, color: SERIES[j % SERIES.length] }));
  return (
    <>
      <Legend items={items} />
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <RadarChart data={data} outerRadius="62%">
            <PolarGrid stroke="var(--grid)" />
            <PolarAngleAxis dataKey="label" tick={AxisTick} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const i = labels.indexOf(payload[0].payload.label);
                return (
                  <div className="chart-tooltip">
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{payload[0].payload.label}</div>
                    {series.map((s, j) => (
                      <div className="row" key={s.name}>
                        <span>
                          <i className="swatch" style={{ background: SERIES[j % SERIES.length] }} /> {s.name}
                        </span>
                        <strong>{s.axes[i].missing ? 'keine Daten' : `${s.axes[i].display} · ${Math.round(s.axes[i].value)}/100`}</strong>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {series.map((s, j) => (
              <Radar
                key={s.name}
                name={s.name}
                dataKey={`v${j}`}
                stroke={SERIES[j % SERIES.length]}
                fill={SERIES[j % SERIES.length]}
                fillOpacity={series.length > 1 ? 0.08 : 0.25}
                strokeWidth={2}
              />
            ))}
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
