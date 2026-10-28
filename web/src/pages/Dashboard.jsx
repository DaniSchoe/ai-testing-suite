import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Boxes, FileText, Gauge, Info, Landmark, Lock, MemoryStick, ShieldAlert, ShieldCheck, Target } from 'lucide-react';
import { RadarProfile, TrendLines, ValueBars } from '../components/Charts.jsx';
import { Card, Empty, EnvBadge, getPlatform, fmt, KIND_META, Loading, Modal, OutcomeBadge, PageHead, PATH_LABELS, pctText, SeverityBadge, STATUS_KINDS, StatusBadge, TYPE_LABELS, useApi } from '../lib.jsx';

const DIMENSIONS = [
  ['quality', 'Qualität'],
  ['security', 'Sicherheit'],
  ['performance', 'Performance'],
  ['efficiency', 'Effizienz'],
  ['sovereignty', 'Souveränität'],
];
const RATING = {
  suitable: ['passed', 'geeignet'],
  conditional: ['warn', 'bedingt'],
  unsuitable: ['failed', 'ungeeignet'],
  incomplete: ['queued', 'zu wenig Daten'],
  not_applicable: ['skipped', 'nicht anwendbar'],
};

// Änderungen aus den Snapshots als Text.
function changeText(c) {
  if (c.message || c.what) return c.message ?? c.what;
  if (c.type === 'component_added') return `Komponente ${c.name} hinzugefügt`;
  if (c.type === 'version') return `${c.name}: Version ${c.from ?? '–'} → ${c.to ?? '–'}`;
  if (c.type === 'model') return `Modell ${c.name}: ${c.from ?? '–'} → ${c.to ?? '–'}`;
  if (c.type === 'cluster') return c.name;
  return c.name ?? c.type ?? 'Änderung';
}

// Tage ohne Tests als 0 auffüllen, damit der Verlauf nicht über Lücken hinweg verbunden wird.
function testsPerDay(trend, days = 30) {
  const byDay = new Map(trend.map((t) => [t.day, t]));
  const out = [];
  for (let i = Math.min(days, 90) - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const t = byDay.get(day);
    out.push({ day, Absolviert: t?.total ?? 0, Bestanden: t?.passed ?? 0 });
  }
  return out;
}

export default function Dashboard() {
  const [params, setParams] = useSearchParams();
  const platform = getPlatform();
  const model = params.get('model');
  const [days, setDays] = useState(30);
  const [scales, setScales] = useState(false);
  const go = (next) => setParams(next);
  return (
    <>
      <PageHead
        title="Dashboard"
        action={
          <div className="btn-row">
            <select className="inline" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Zeitraum">
              <option value={7}>7 Tage</option>
              <option value={30}>30 Tage</option>
              <option value={90}>90 Tage</option>
              <option value={365}>12 Monate</option>
            </select>
            <button className="btn" onClick={() => setScales(true)}>
              <Info size={15} /> Skalen
            </button>
          </div>
        }
      >
        Zentraler Einstieg für die oben gewählte Plattform: Findings, Berichte und Souveränität öffnest du über die Kacheln. Es zählen nur Läufe von Prüfungen, keine Testläufe.
      </PageHead>
      {!platform && <Empty>Noch keine Plattform. Lege unter Ziele › Plattformen eine an.</Empty>}
      {platform && !model && <PlatformLevel id={platform} days={days} go={go} />}
      {platform && model && <ModelLevel platformId={platform} model={model} days={days} go={go} />}
      {scales && <ScalesDialog onClose={() => setScales(false)} />}
    </>
  );
}

function Tile({ to, Icon, title, value, sub, bad }) {
  return (
    <Link className="tile" to={to}>
      <span className="tile-icon">
        <Icon size={18} />
      </span>
      <h3>{title}</h3>
      <div className="kpi-value" style={bad ? { color: 'var(--bad, #dc2626)' } : undefined}>
        {value}
      </div>
      <div className="sub">{sub}</div>
    </Link>
  );
}

function Kpi({ label, value, sub, bad }) {
  return (
    <section className="card kpi">
      <div className="kpi-top">{label}</div>
      <div className="kpi-value" style={bad ? { color: 'var(--bad, #dc2626)' } : undefined}>
        {value}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </section>
  );
}

function Back({ onClick, children }) {
  return (
    <button className="btn sm" onClick={onClick} style={{ marginBottom: 12 }}>
      <ArrowLeft size={14} /> {children}
    </button>
  );
}

function Dim({ d }) {
  if (!d) return <span className="sub">–</span>;
  return (
    <span title={d.ci95 ? `95-%-Intervall ${d.ci95[0]}–${d.ci95[1]}, ${d.n} Fälle` : undefined}>
      <strong>{d.value}</strong>
      {d.ci95 && (
        <span className="sub">
          {' '}
          ({d.ci95[0]}–{d.ci95[1]})
        </span>
      )}
      {d.low_confidence && <AlertTriangle size={12} style={{ marginLeft: 4, color: 'var(--warn, #c77d12)' }} aria-label="geringe Aussagekraft" />}
    </span>
  );
}

function Suitability({ items }) {
  return (
    <div className="btn-row">
      {items.map((s) => {
        const [cls, text] = RATING[s.rating] ?? ['queued', s.rating];
        return (
          <span key={s.key} className={`badge ${cls}`} title={s.note ?? `Abdeckung ${pctText(s.coverage)}`}>
            {s.label}: {s.value !== undefined ? `${s.value} ` : ''}
            {text}
          </span>
        );
      })}
    </div>
  );
}

const fmtGb = (gb) => (gb >= 1000 ? `${Math.round(gb / 10) / 100} TB` : `${Math.round(gb)} GB`);
const speedOf = (d, alias) => d.speed.find((s) => s.alias === alias) ?? {};

function PlatformLevel({ id, days, go }) {
  const data = useApi(`/api/dashboard/platforms/${id}?days=${days}`, { interval: 60000 });
  return (
    <Loading state={data}>
      {(d) => (
        <>
          <h2 style={{ margin: '0 0 12px' }}>
            {d.platform.name} <EnvBadge env={d.platform.environment} />
            {d.platform.locked && <span className="badge failed" style={{ marginLeft: 8 }}>gesperrt: {d.platform.locked_reason}</span>}
          </h2>
          {d.view === 'customer' && <div className="hint">Kundenansicht: Rohdaten und Fehlermeldungen sind ausgeblendet.</div>}
          <div className="tile-grid" style={{ marginBottom: 14 }}>
            <Tile to="/findings" Icon={ShieldAlert} title="Findings" bad={Boolean(d.findings.open.critical)}
              value={Object.values(d.findings.open).reduce((a, b) => a + b, 0)}
              sub={d.findings.open.critical ? `${d.findings.open.critical} kritisch` : 'offen'} />
            <Tile to="/reports" Icon={FileText} title="Berichte" value={d.reports?.total ?? 0} sub={`${d.reports?.approved ?? 0} freigegeben`} />
            <Tile to="/sovereignty" Icon={Landmark} title="Souveränität"
              value={d.sovereignty?.goals?.filter((g) => g.status === 'ok').length ?? 0} sub={`von ${d.sovereignty?.goals?.length ?? 0} Zielen erfüllt`} />
            <Tile to="/sovereignty" Icon={ShieldCheck} title="SEAL-Stufe"
              value={d.sovereignty?.overall != null ? `SEAL-${d.sovereignty.overall}` : '–'}
              sub={`Ziel mindestens SEAL-${d.sovereignty?.min_level ?? '–'}`} bad={d.sovereignty?.overall != null && d.sovereignty.overall < (d.sovereignty?.min_level ?? 0)} />
            <Tile to={`/platforms/${d.platform.id}?tab=assessment`} Icon={Gauge} title="Einstufung"
              value={d.assessment ? `${d.assessment.security.score ?? '–'} / ${d.assessment.production.score ?? '–'}` : '–'} sub="Sicherheit / Produktionsreife" />
            <Tile to="/audits" Icon={Target} title="Anforderungen erfüllt" value={pctText(d.slo.rate)} sub={`${d.slo.fulfilled} von ${d.slo.total} (95 %: ${pctText(d.slo.ci95?.[0])}–${pctText(d.slo.ci95?.[1])})`} />
            <Tile to="/models" Icon={Boxes} title="Modelle" value={d.models.length} sub="mit Messungen im Zeitraum" />
            <Tile to={`/platforms/${d.platform.id}`} Icon={MemoryStick} title="VRAM gesamt"
              value={d.vram?.gpus ? fmtGb(d.vram.total_gb) : '–'}
              sub={d.vram?.gpus ? `${d.vram.gpus} GPU in ${d.vram.servers} Server` : 'Keine GPU an einem Server eingepflegt'} />
          </div>
          <div className="two-col">
            <Card title="Token/s je Modell" sub="Mittlerer Durchsatz aus Performance- und Lasttests aller getesteten Modelle.">
              {d.speed.some((s) => s.tokens_per_s !== null) ? <ValueBars data={d.speed.filter((s) => s.tokens_per_s !== null).map((s) => ({ name: s.alias, value: s.tokens_per_s }))} unit=" Token/s" /> : <Empty>Noch keine Performance-Messung</Empty>}
            </Card>
            <Card title="Mittlere TTFT nach Weg" sub="Zeit bis zum ersten Token bei Anfragen über das Gateway und direkt an die Inferenz.">
              {d.ttft_by_path.gateway !== null || d.ttft_by_path.direct !== null ? (
                <ValueBars data={[{ name: 'Über Gateway', value: d.ttft_by_path.gateway }, { name: 'Direkt zur Inferenz', value: d.ttft_by_path.direct }]} unit=" ms" colors={['var(--series-1)', 'var(--series-2)']} />
              ) : (
                <Empty>Noch keine TTFT-Messung</Empty>
              )}
            </Card>
          </div>
          <Card title="Komponenten" flush>
            <table>
              <tbody>
                {(d.status?.components ?? []).filter((c) => STATUS_KINDS.includes(c.kind)).map((c) => (
                  <tr key={c.endpoint_id}>
                    <td>{c.name}</td>
                    <td className="sub">{KIND_META[c.kind]?.label ?? c.kind}</td>
                    <td>
                      {c.status === 'n/a' ? <span className="sub">nicht überwacht</span> : <span className={`badge ${c.status === 'up' ? 'passed' : 'failed'}`}>{c.status === 'up' ? 'erreichbar' : 'gestört'}</span>}
                    </td>
                    <td className="sub">{c.version ?? ''}</td>
                    <td className="sub">{c.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Scorecard der Modelle" sub="Werte 0–100 mit 95-%-Intervall; ⚠ bedeutet geringe Aussagekraft wegen weniger Fälle." flush>
            {d.models.length === 0 ? (
              <Empty>Noch keine Messungen in diesem Zeitraum.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Modell</th>
                      {DIMENSIONS.map(([k, l]) => (
                        <th key={k}>{l}</th>
                      ))}
                      <th>Eignung</th>
                      <th>TTFT</th>
                      <th>Token/s</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.models.map((m) => (
                      <tr key={m.alias} onClick={() => go({ model: m.alias })} style={{ cursor: 'pointer' }}>
                        <td>
                          <span className="title-link">{m.alias}</span>
                          <div className="sub">{m.capabilities.join(', ')}</div>
                        </td>
                        {DIMENSIONS.map(([k]) => (
                          <td key={k}>
                            <Dim d={m.scorecard.dimensions[k]} />
                          </td>
                        ))}
                        <td>
                          <Suitability items={m.suitability} />
                        </td>
                        <td>{speedOf(d, m.alias).ttft_ms !== null && speedOf(d, m.alias).ttft_ms !== undefined ? `${Math.round(speedOf(d, m.alias).ttft_ms)} ms` : <span className="sub">–</span>}</td>
                        <td>{speedOf(d, m.alias).tokens_per_s !== null && speedOf(d, m.alias).tokens_per_s !== undefined ? speedOf(d, m.alias).tokens_per_s : <span className="sub">–</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Heatmap heatmap={d.heatmap} />
          <Recommendations items={d.recommendations} />
          <div className="two-col">
            <Card title="Absolvierte Tests" sub="Anzahl abgeschlossener Testfälle pro Tag. Marker zeigen Änderungen der Plattform (Version, Modell, Konfiguration) zwischen Läufen.">
              {d.trend.length > 0 ? <TrendLines data={testsPerDay(d.trend, d.days)} keys={['Absolviert', 'Bestanden']} valueFormatter={(v) => String(Math.round(v))} height={200} /> : <Empty>Noch keine abgeschlossenen Tests im Zeitraum</Empty>}
              {d.markers.map((m) => (
                <div key={m.run_id} className="sub">
                  {fmt.day(m.at)}: {m.changes.map(changeText).join('; ')}
                </div>
              ))}
            </Card>
            <Card title="Top-Findings" flush>
              <table>
                <tbody>
                  {d.findings.top.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td>
                        <Link to="/findings">{f.title}</Link>
                        <div className="sub">
                          {f.model} · {PATH_LABELS[f.path] ?? f.path}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {d.findings.top.length === 0 && (
                    <tr>
                      <td className="empty">Keine offenen Findings</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </div>
          {d.slo.failing?.length > 0 && (
            <Card title="Nicht erfüllte Anforderungen" flush>
              <table>
                <tbody>
                  {d.slo.failing.map((f, i) => (
                    <tr key={i}>
                      <td>{f.template}</td>
                      <td>{f.model}</td>
                      <td className="sub">{PATH_LABELS[f.path] ?? f.path}</td>
                      <td className="sub">{f.rules.map((r) => `${r.metric} ${r.op} ${r.value}`).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </Loading>
  );
}

// OWASP-Heatmap: je Modell und Pfad, ob das Gateway blockiert oder das Modell selbst verweigert hat.
function Heatmap({ heatmap }) {
  if (!heatmap?.columns?.length) return null;
  return (
    <Card title="OWASP LLM Top 10" sub="Bestehensquote je Kategorie. Zeigt, ob das Gateway Angriffe blockiert oder erst das Modell verweigert." flush>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Kategorie</th>
              {heatmap.columns.map((c) => (
                <th key={c.key}>
                  {c.model} <span className="sub">{PATH_LABELS[c.path] ?? c.path}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heatmap.rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {r.key} <span className="sub">{r.name}</span>
                </td>
                {heatmap.columns.map((c) => {
                  const cell = r.cells[c.key];
                  if (!cell) return <td key={c.key} className="sub">nicht geprüft</td>;
                  const rate = cell.passed / cell.total;
                  return (
                    <td key={c.key} title={`Gateway blockiert: ${cell.blocked_by_gateway}, Modell verweigert: ${cell.model_refusals}`}>
                      <span className={`badge ${rate === 1 ? 'passed' : rate >= 0.8 ? 'warn' : 'failed'}`}>
                        {cell.passed}/{cell.total}
                      </span>
                      <span className="sub">
                        {' '}
                        GW {cell.blocked_by_gateway} · Modell {cell.model_refusals}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ModelLevel({ platformId, model, days, go }) {
  const data = useApi(`/api/dashboard/models?platform_id=${platformId}&model=${encodeURIComponent(model)}&days=${days}`);
  return (
    <Loading state={data}>
      {(d) => {
        const paths = Object.entries(d.by_path);
        const viaGateway = paths.filter(([path]) => path === 'gateway');
        const series = (viaGateway.length ? viaGateway : paths.length ? paths : [['gesamt', d.scorecard]]).map(([path, card]) => ({
          name: PATH_LABELS[path] ?? path,
          axes: DIMENSIONS.map(([k, label]) => ({ label, value: card.dimensions[k]?.value ?? 0, display: card.dimensions[k] ? `${card.dimensions[k].value}` : 'keine Daten', missing: !card.dimensions[k] })),
        }));
        const trend = d.trend.map((t) => ({ day: t.at, Qualität: t.quality, Sicherheit: t.security }));
        return (
          <>
            <Back onClick={() => go({})}>{d.platform.name}</Back>
            <h2 style={{ margin: '0 0 4px' }}>
              {d.model} <EnvBadge env={d.platform.environment} />
            </h2>
            <div className="sub" style={{ marginBottom: 12 }}>
              {[d.info?.provider, d.info?.license, d.info?.origin, d.info?.quantization, d.info?.open_weights ? 'Open Weights' : null, d.info?.revision && `rev ${d.info.revision}`].filter(Boolean).join(' · ')}
              {d.capabilities.length > 0 && ` · Fähigkeiten: ${d.capabilities.join(', ')}`}
            </div>
            <Suitability items={d.suitability} />
            <div className="two-col" style={{ marginTop: 12 }}>
              <Card title="Profil" sub="Bewertung über das Gateway.">
                <RadarProfile series={series} />
              </Card>
              <Card title="Verlauf" sub="Anteil bestandener Fälle je Lauf.">
                {trend.length > 1 ? <TrendLines data={trend} keys={['Qualität', 'Sicherheit']} valueFormatter={(v) => pctText(v)} height={260} /> : <Empty>Zu wenige Datenpunkte</Empty>}
                {d.markers.map((m) => (
                  <div key={m.run_id} className="sub">
                    {fmt.day(m.at)}: {m.changes.map(changeText).join('; ')}
                  </div>
                ))}
              </Card>
            </div>
            <Card title="Letzte Ergebnisse je Vorlage" flush>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Vorlage</th>
                      <th>Pfad</th>
                      <th>Ergebnis</th>
                      <th className="num">Score</th>
                      <th className="num">Fälle</th>
                      <th>Hinweise</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.results.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/runs/${r.run_id}`}>{r.template}</Link> <span className="sub mono">{r.version}</span>
                          <div className="sub">{TYPE_LABELS[r.type] ?? r.type}</div>
                        </td>
                        <td className="sub">{PATH_LABELS[r.path] ?? r.path}</td>
                        <td>
                          <OutcomeBadge outcome={r.outcome} />
                        </td>
                        <td className="num">{r.score === null ? '–' : pctText(r.score)}</td>
                        <td className="num">{r.cases_total ?? '–'}</td>
                        <td className="sub">
                          {r.small_sample && 'kleine Stichprobe '}
                          {r.regressions?.length > 0 && 'Regression'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            {d.baselines.length > 0 && (
              <Card title="Baselines" flush>
                <table>
                  <tbody>
                    {d.baselines.map((b) => (
                      <tr key={b.audit_id}>
                        <td>
                          <Link to={`/audits/${b.audit_id}`}>{b.name}</Link>
                        </td>
                        <td className="sub">{fmt.date(b.at)}</td>
                        <td>
                          <Link to={`/runs/${b.baseline_run_id}`}>Lauf</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
            {d.findings.length > 0 && (
              <Card title="Findings" flush>
                <table>
                  <tbody>
                    {d.findings.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <SeverityBadge severity={f.severity} />
                        </td>
                        <td>{f.title}</td>
                        <td className="sub">
                          {PATH_LABELS[f.path] ?? f.path} · {f.category}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        );
      }}
    </Loading>
  );
}

// Dokumentierte Normalisierung, damit die Werte der Scorecard nachvollziehbar sind.
function ScalesDialog({ onClose }) {
  const n = useApi('/api/dashboard/normalization');
  return (
    <Modal
      title="So entstehen die Werte"
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Schließen
        </button>
      }
    >
      {n.data && (
        <>
          <p className="sub">Normalisierung Version {n.data.version}. Alle Werte liegen zwischen 0 und 100.</p>
          {Object.entries(n.data.dimensions).map(([k, dim]) => (
            <div key={k} style={{ marginBottom: 10 }}>
              <strong>{dim.label}</strong>
              <div className="sub">{dim.description}</div>
              {dim.scales &&
                Object.entries(dim.scales).map(([m, s]) => (
                  <div key={m} className="sub mono">
                    {m}: 100 bei {s.full}, 0 bei {s.zero} ({s.unit})
                  </div>
                ))}
            </div>
          ))}
          <strong>Eignungsprofile</strong>
          {Object.entries(n.data.profiles).map(([k, p]) => (
            <div key={k} className="sub">
              {p.label}: {Object.entries(p.weights).map(([m, w]) => `${m} ${w} %`).join(', ')}
            </div>
          ))}
          <div className="sub" style={{ marginTop: 8 }}>
            geeignet ab {n.data.suitability.suitable}, bedingt ab {n.data.suitability.conditional}; Abdeckung mindestens {pctText(n.data.suitability.min_coverage)}.
          </div>
        </>
      )}
    </Modal>
  );
}

function Recommendations({ items }) {
  return (
    <Card title="Top-5-Empfehlungen" sub="Welche offenen Punkte die Souveränitätsziele am stärksten verbessern würden.">
      {items?.length ? (
        <ol className="recommendations">
          {items.map((r) => (
            <li key={r.id}>
              <strong>{r.label}</strong>
              <div className="sub">{r.detail}</div>
              <div className="sub">
                Wirkung:{' '}
                {r.effects
                  .map((e) => `${e.goal}${e.levels > 0 ? ` (SEAL-${e.from ?? '–'} → SEAL-${e.to})` : e.points > 0 ? ` (+${e.points} Punkte)` : ''}`)
                  .join(', ')}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>Keine offenen Empfehlungen</Empty>
      )}
    </Card>
  );
}
