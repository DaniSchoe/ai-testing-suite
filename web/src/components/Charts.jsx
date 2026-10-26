// Diagramme im Stil der Vorlage: dünne Marken, dezente Achsen, Tooltip bei Hover, Legende ab zwei Reihen.
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
