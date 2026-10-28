// Einstufung einer Plattform: Sicherheit, Produktionsreife und Souveränitätsziele (SEAL 0 bis 4).
// Grundlage sind Inventar, Topologie, Modellportfolio, Betriebszustand und die neuesten Prüfergebnisse. Jede Einstufung besteht aus
// einzelnen Prüfpunkten mit Begründung; fehlende Belege zählen nicht als bestanden, sondern senken nur die Abdeckung.
import { many, one } from './db.js';
import { latestResults, SEAL, sealFromRate } from './dashboard.js';
import { EU_COUNTRIES, GATEWAY_PRODUCTS, HOSTING_PROVIDERS, INFERENCE_PROVIDERS, K8S_DISTRIBUTIONS, URL_KINDS } from './inventory.js';
import { platformEndpoints, platformStatus } from './snapshot.js';

const VALUE = { pass: 1, warn: 0.5, fail: 0 };
const check = (id, label, status, detail, weight = 1, source = 'inventory') => ({ id, label, status, detail, weight, source });
const plural = (n, one_, many_) => `${n} ${n === 1 ? one_ : many_}`;
const hasCert = (list, re) => (list ?? []).some((c) => re.test(c));
const share = (n, total) => (total ? n / total : null);
const grade = (rate) => (rate === null ? 'unknown' : rate >= 0.999 ? 'pass' : rate >= 0.5 ? 'warn' : 'fail');

// Bestehensquote einer Menge von Prüfergebnissen als Prüfpunkt.
function testCheck(id, label, rows, weight = 2) {
  if (!rows.length) return check(id, label, 'unknown', 'Noch kein Test dazu gelaufen (letzte 90 Tage)', weight, 'test');
  const passed = rows.filter((r) => r.status === 'passed').length;
  const rate = passed / rows.length;
  return check(id, label, rate >= 0.95 ? 'pass' : rate >= 0.8 ? 'warn' : 'fail', `${passed} von ${rows.length} Tests bestanden`, weight, 'test');
}

export async function loadContext(tenantId, platform) {
  const [endpoints, links, routes, results, portfolio, findings, audits, goals, goalLinks] = await Promise.all([
    platformEndpoints(platform.id),
    many('select * from platform_links where platform_id = $1', [platform.id]),
    many('select * from platform_routes where platform_id = $1', [platform.id]),
    latestResults(tenantId, { platformId: platform.id, days: 90 }),
    many(
      `select distinct p.* from portfolio_models p join endpoint_models m on m.portfolio_id = p.id join endpoints e on e.id = m.endpoint_id
       where e.platform_id = $1 and m.available`,
      [platform.id],
    ),
    many(`select severity, count(*)::int as n from findings where platform_id = $1 and status in ('open', 'in_progress') group by 1`, [platform.id]),
    many(
      `select a.id, a.baseline_run_id, exists (select 1 from schedules s where s.audit_id = a.id and s.enabled) as scheduled
       from audits a where a.platform_id = $1`,
      [platform.id],
    ),
    many(`select key, name from categories where framework = 'SOV' and tenant_id is null order by key`),
    many(
      `select distinct t.key as template_key, c.key as goal from templates t join template_versions v on v.template_id = t.id
       join template_version_categories tc on tc.version_id = v.id join categories c on c.id = tc.category_id where c.framework = 'SOV'`,
    ),
  ]);
  let status = null;
  try {
    status = await platformStatus(platform.id);
  } catch {
    /* Status ist optional */
  }
  const of = (kind) => endpoints.filter((e) => e.kind === kind && e.enabled);
  const inference = of('llm');
  return {
    platform,
    endpoints,
    links,
    routes,
    results,
    portfolio,
    findings: Object.fromEntries(findings.map((f) => [f.severity, f.n])),
    audits,
    goals,
    goalLinks,
    status,
    datacenters: of('datacenter'),
    clusters: of('kubernetes'),
    gpus: of('gpu'),
    interconnects: of('interconnect'),
    inference,
    selfHosted: inference.filter((e) => e.spec?.hosting !== 'managed'),
    managed: inference.filter((e) => e.spec?.hosting === 'managed'),
    gateways: of('ai_proxy'),
    mcps: of('mcp'),
    byId: new Map(endpoints.map((e) => [e.id, e])),
  };
}

const provider = (e) => INFERENCE_PROVIDERS.find((p) => p.key === e.spec?.provider);
const resultsOf = (ctx, pred) => ctx.results.filter(pred);
const byTemplate = (ctx, key) => resultsOf(ctx, (r) => r.template_key === key);
const byType = (ctx, ...types) => resultsOf(ctx, (r) => types.includes(r.type));

export function summarize(checks) {
  const known = checks.filter((c) => c.status !== 'unknown');
  const weight = known.reduce((n, c) => n + c.weight, 0);
  const total = checks.reduce((n, c) => n + c.weight, 0);
  const score = weight ? Math.round((100 * known.reduce((n, c) => n + c.weight * VALUE[c.status], 0)) / weight) : null;
  const coverage = total ? weight / total : 0;
  const level = score === null || coverage < 0.4 ? 'incomplete' : score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad';
  return { score, coverage, level, checks };
}

const INTERNAL_URL = /(localhost|127\.0\.0\.1|\.svc(\.|:|\/|$)|\.local(:|\/|$))/i;

export function securityChecks(ctx) {
  const urls = ctx.endpoints.filter((e) => URL_KINDS.includes(e.kind) && e.base_url);
  const plain = urls.filter((e) => !/^https:/i.test(e.base_url));
  const external = plain.filter((e) => !INTERNAL_URL.test(e.base_url));
  const out = [];
  out.push(
    !urls.length
      ? check('tls', 'Verschlüsselte Verbindungen (TLS)', 'unknown', 'Keine Komponenten mit URL', 2)
      : external.length
        ? check('tls', 'Verschlüsselte Verbindungen (TLS)', 'fail', `Unverschlüsselt über das Netz: ${external.map((e) => e.name).join(', ')}`, 2)
        : plain.length
          ? check('tls', 'Verschlüsselte Verbindungen (TLS)', 'warn', `Nur clusterintern ohne TLS: ${plain.map((e) => e.name).join(', ')}`, 2)
          : check('tls', 'Verschlüsselte Verbindungen (TLS)', 'pass', `Alle ${plural(urls.length, 'Komponente', 'Komponenten')} per HTTPS`, 2),
  );
  out.push(
    ctx.gateways.length
      ? check('gateway', 'AI Gateway als zentraler Zugang', 'pass', ctx.gateways.map((g) => g.name).join(', '), 2)
      : check('gateway', 'AI Gateway als zentraler Zugang', 'warn', 'Ohne Gateway fehlen zentrale Zugriffskontrolle und Protokollierung', 2),
  );
  out.push(testCheck('access', 'Zugriffstests: unberechtigte Anfragen werden abgelehnt', byType(ctx, 'access'), 3));
  out.push(testCheck('security-tests', 'Sicherheitstests (Prompt Injection, Datenabfluss, Jailbreak)', byType(ctx, 'security'), 3));
  const net = byType(ctx, 'network');
  out.push(
    !net.length
      ? check('network', 'Netzwerk-Isolation (Egress)', 'unknown', 'Noch kein Netzwerk-Test gelaufen', 2, 'test')
      : net.every((r) => r.status === 'passed')
        ? check('network', 'Netzwerk-Isolation (Egress)', 'pass', net.some((r) => r.metrics?.air_gapped === 1) ? 'Air-Gapped: keine der Testseiten erreichbar' : 'Gesperrte Seiten sind nicht erreichbar', 2, 'test')
        : check('network', 'Netzwerk-Isolation (Egress)', 'fail', `${net.reduce((n, r) => n + (Number(r.metrics?.unexpected_reachable) || 0), 0)} Seiten erreichbar, die gesperrt sein sollten`, 2, 'test'),
  );
  const severe = (ctx.findings.critical ?? 0) + (ctx.findings.high ?? 0);
  const medium = ctx.findings.medium ?? 0;
  out.push(
    !ctx.results.length
      ? check('findings', 'Offene Findings', 'unknown', 'Noch keine Prüfung gelaufen', 3, 'test')
      : severe
        ? check('findings', 'Offene Findings', 'fail', `${plural(severe, 'kritisches oder hohes Finding', 'kritische oder hohe Findings')} offen`, 3, 'test')
        : medium
          ? check('findings', 'Offene Findings', 'warn', `${plural(medium, 'mittleres Finding', 'mittlere Findings')} offen`, 3, 'test')
          : check('findings', 'Offene Findings', 'pass', 'Keine kritischen, hohen oder mittleren Findings offen', 3, 'test'),
  );
  out.push(
    ctx.endpoints.some((e) => e.kind === 'iam')
      ? check('iam', 'Identitätsmanagement angebunden', 'pass', 'IAM-Komponente im Inventar', 1)
      : check('iam', 'Identitätsmanagement angebunden', 'warn', 'Keine IAM-Komponente im Inventar', 1),
  );
  out.push(
    ctx.endpoints.some((e) => e.kind === 'observability')
      ? check('observability', 'Beobachtbarkeit und Protokollierung', 'pass', 'Observability-Komponente im Inventar', 1)
      : check('observability', 'Beobachtbarkeit und Protokollierung', 'warn', 'Keine Observability-Komponente im Inventar', 1),
  );
  // MCP-Server: Authentifizierung per Bearer Token oder OIDC.
  if (ctx.mcps.length) {
    const secured = ctx.mcps.filter((m) => ['bearer', 'oidc'].includes(m.spec?.auth?.type));
    out.push(
      check('mcp-auth', 'MCP-Server sind abgesichert (Bearer Token oder OIDC)', secured.length === ctx.mcps.length ? 'pass' : secured.length ? 'warn' : 'fail',
        secured.length === ctx.mcps.length ? ctx.mcps.map((m) => `${m.name}: ${m.spec.auth.type === 'oidc' ? 'OIDC' : 'Bearer Token'}`).join('; ') : `Ohne Authentifizierung: ${names(ctx.mcps.filter((m) => !secured.includes(m)))}`, 2),
    );
  }
  // Erreichbarkeit der selbst betriebenen Inferenzserver: nur intern über das Gateway ist sicherer als direkt.
  if (ctx.selfHosted.length) {
    const internal = ctx.selfHosted.filter((i) => i.spec?.reachability === 'gateway_only');
    out.push(
      check('exposure', 'Inferenzserver nur intern über ein Gateway erreichbar', grade(share(internal.length, ctx.selfHosted.length)),
        internal.length === ctx.selfHosted.length ? 'Alle selbst betriebenen Inferenzserver sind nur über das Gateway erreichbar' : `Direkt erreichbar: ${names(ctx.selfHosted.filter((i) => !internal.includes(i)))}`, 1.5),
    );
  }
  if (ctx.clusters.length) {
    const hardened = ctx.clusters.filter((c) => c.spec?.cis_hardened === true);
    const known = ctx.clusters.filter((c) => c.spec?.cis_hardened !== null && c.spec?.cis_hardened !== undefined);
    out.push(
      known.length
        ? check('cis', 'Kubernetes nach CIS-Standard gehärtet', grade(share(hardened.length, ctx.clusters.length)), ctx.clusters.map((c) => `${c.name}: ${c.spec?.cis_hardened === true ? 'gehärtet' : c.spec?.cis_hardened === false ? 'nicht gehärtet' : 'unbekannt'}`).join('; '), 1)
        : check('cis', 'Kubernetes nach CIS-Standard gehärtet', 'unknown', 'Keine Angabe zur Härtung', 1),
    );
  }
  if (ctx.datacenters.length) {
    const certified = ctx.datacenters.filter((d) => hasCert(d.spec?.certifications, /27001|C5|NIST|SecNumCloud|SOC ?2|TISAX|EUCS|FedRAMP/i));
    out.push(
      certified.length === ctx.datacenters.length
        ? check('dc-cert', 'Sicherheitszertifizierung des Rechenzentrums', 'pass', ctx.datacenters.map((d) => `${d.name}: ${d.spec.certifications.join(', ')}`).join('; '), 1.5)
        : check('dc-cert', 'Sicherheitszertifizierung des Rechenzentrums', 'fail', `Ohne Zertifikat: ${ctx.datacenters.filter((d) => !certified.includes(d)).map((d) => d.name).join(', ')}`, 1.5),
    );
  } else out.push(check('dc-cert', 'Sicherheitszertifizierung des Rechenzentrums', 'unknown', 'Kein Rechenzentrum im Inventar', 1.5));
  if (ctx.selfHosted.length) {
    const routed = ctx.selfHosted.filter((i) => ctx.routes.some((r) => r.backend_endpoint_id === i.id));
    out.push(
      check('routed', 'Inferenzserver nur über das Gateway vorgesehen', grade(share(routed.length, ctx.selfHosted.length)), `${routed.length} von ${ctx.selfHosted.length} selbst betriebenen Inferenzservern haben eine Route vom Gateway`, 1),
    );
  }
  return out;
}

export function productionChecks(ctx) {
  const out = [];
  if (ctx.platform.locked) out.push(check('locked', 'Plattform freigegeben', 'fail', `Gesperrt (Kill-Switch)${ctx.platform.locked_reason ? `: ${ctx.platform.locked_reason}` : ''}`, 3));
  out.push(
    ctx.gateways.length
      ? check('gateway', 'AI Gateway vorhanden', 'pass', ctx.gateways.map((g) => g.name).join(', '), 2)
      : check('gateway', 'AI Gateway vorhanden', 'fail', 'Kein AI Gateway im Inventar', 2),
  );
  out.push(
    ctx.inference.length && ctx.portfolio.length
      ? check('serving', 'Modelle werden bereitgestellt', 'pass', `${plural(ctx.inference.length, 'Inferenzserver', 'Inferenzserver')}, ${plural(ctx.portfolio.length, 'Modell', 'Modelle')} im Portfolio`, 2)
      : check('serving', 'Modelle werden bereitgestellt', 'fail', ctx.inference.length ? 'Kein Modell aus dem Portfolio auf dieser Plattform' : 'Kein Inferenzserver im Inventar', 2),
  );
  if (ctx.selfHosted.length) {
    const placed = ctx.selfHosted.filter((i) => ctx.links.some((l) => l.kind === 'runs_on' && l.from_id === i.id));
    const gpusPlaced = ctx.gpus.filter((g) => ctx.links.some((l) => ['hosted_in', 'cluster'].includes(l.kind) && l.from_id === g.id));
    const rate = share(placed.length + gpusPlaced.length, ctx.selfHosted.length + ctx.gpus.length);
    out.push(
      check('topology', 'Topologie vollständig (Inferenzserver auf GPUs, GPUs im Rechenzentrum oder Cluster)', grade(rate), `${placed.length} von ${ctx.selfHosted.length} Inferenzservern einer GPU zugeordnet, ${gpusPlaced.length} von ${ctx.gpus.length} GPUs einem Standort zugeordnet`, 2, 'topology'),
    );
  }
  productionOperations(ctx, out);
  return out;
}

// Betrieb: Redundanz, Metriken, Zustand, Tests, Zeitplan, Baseline, kritische Findings.
function productionOperations(ctx, out) {
  const served = new Map();
  for (const i of ctx.inference) for (const m of i.spec?.served_models ?? []) served.set(m, (served.get(m) ?? 0) + 1);
  const redundant = [...served.values()].filter((n) => n >= 2).length;
  const gatewayHa = ctx.gateways.some((g) => (g.spec?.instances ?? 1) >= 2);
  const how = [redundant ? `${plural(redundant, 'Modell', 'Modelle')} auf mehreren Inferenzservern` : null, gatewayHa ? 'Gateway mit mehreren Instanzen' : null].filter(Boolean).join('; ');
  out.push(
    redundant || gatewayHa
      ? check('redundancy', 'Redundanz', 'pass', how, 2, 'topology')
      : check('redundancy', 'Redundanz', ctx.inference.length ? 'warn' : 'unknown', 'Kein Modell läuft auf mehreren Inferenzservern, das Gateway hat nur eine Instanz', 2, 'topology'),
  );
  const monitorable = [...ctx.gpus, ...ctx.selfHosted];
  if (monitorable.length) {
    const withMetrics = monitorable.filter((e) => e.metrics_url);
    out.push(check('metrics', 'Metriken angebunden (DCGM, Inferenzserver)', grade(share(withMetrics.length, monitorable.length)), `${withMetrics.length} von ${monitorable.length} GPUs und selbst betriebenen Inferenzservern mit Metrics-Endpunkt`, 1.5));
  }
  const live = (ctx.status?.components ?? []).filter((c) => c.status !== 'n/a');
  const up = live.filter((c) => c.status === 'up').length;
  const down = live.filter((c) => c.status !== 'up').map((c) => c.name);
  out.push(
    live.length
      ? check('health', 'Betriebszustand der Komponenten', up === live.length ? 'pass' : up / live.length >= 0.8 ? 'warn' : 'fail', `${up} von ${live.length} Komponenten erreichbar${down.length ? ` (gestört: ${down.join(', ')})` : ''}`, 3, 'status')
      : check('health', 'Betriebszustand der Komponenten', 'unknown', 'Keine abfragbare Komponente', 3, 'status'),
  );
  out.push(testCheck('smoke', 'Health-Test (Smoke)', byType(ctx, 'smoke'), 2));
  out.push(testCheck('load', 'Lasttest', byType(ctx, 'load'), 2));
  out.push(testCheck('quality', 'Qualitätstests der Modelle', byType(ctx, 'quality', 'coding', 'ocr', 'structured', 'thinking'), 1.5));
  const scheduled = ctx.audits.some((a) => a.scheduled);
  out.push(
    ctx.audits.length
      ? check('schedule', 'Regelmäßige Prüfung per Zeitplan', scheduled ? 'pass' : 'warn', scheduled ? 'Mindestens eine Prüfung läuft nach Zeitplan' : 'Keine Prüfung hat einen aktiven Zeitplan', 1.5, 'test')
      : check('schedule', 'Regelmäßige Prüfung per Zeitplan', 'warn', 'Noch keine Prüfung für diese Plattform angelegt', 1.5, 'test'),
  );
  const baseline = ctx.audits.some((a) => a.baseline_run_id);
  out.push(
    ctx.audits.length
      ? check('baseline', 'Baseline für Regressionen', baseline ? 'pass' : 'warn', baseline ? 'Baseline festgelegt' : 'Keine Baseline festgelegt', 1, 'test')
      : check('baseline', 'Baseline für Regressionen', 'unknown', 'Noch keine Prüfung', 1, 'test'),
  );
  const critical = ctx.findings.critical ?? 0;
  out.push(
    !ctx.results.length
      ? check('critical', 'Keine kritischen Findings', 'unknown', 'Noch keine Prüfung gelaufen', 3, 'test')
      : check('critical', 'Keine kritischen Findings', critical ? 'fail' : 'pass', critical ? plural(critical, 'kritisches Finding offen', 'kritische Findings offen') : 'Keine kritischen Findings offen', 3, 'test'),
  );
}

// --- Souveränitätsziele -------------------------------------------------------------------------------------------------------
const jurisdictionOf = (dc) => HOSTING_PROVIDERS.find((p) => p.key === dc.spec?.provider)?.jurisdiction ?? 'other';
const isEu = (dc) => EU_COUNTRIES.includes(dc.spec?.country);
const names = (list) => list.map((e) => e.name).join(', ');

function managedExposure(ctx) {
  if (!ctx.inference.length) return check('managed', 'Inferenz bei externen Diensten', 'unknown', 'Kein Inferenzserver im Inventar', 3);
  if (!ctx.managed.length) return check('managed', 'Inferenz bei externen Diensten', 'pass', 'Alle Inferenzserver werden selbst betrieben', 3);
  const labels = names(ctx.managed);
  return check('managed', 'Inferenz bei externen Diensten', ctx.selfHosted.length ? 'warn' : 'fail', `Externe Dienste im Einsatz: ${labels}`, 3);
}

function openWeights(ctx, weight = 2) {
  const m = ctx.portfolio;
  if (!m.length) return check('open-weights', 'Open-Weights-Modelle', 'unknown', 'Keine Modelle im Portfolio', weight, 'portfolio');
  const n = m.filter((x) => x.open_weights === true).length;
  return check('open-weights', 'Open-Weights-Modelle', grade(n / m.length), `${n} von ${m.length} Modellen mit offenen Gewichten`, weight, 'portfolio');
}

function metadataShare(ctx, id, label, field, weight = 1) {
  const m = ctx.portfolio;
  if (!m.length) return check(id, label, 'unknown', 'Keine Modelle im Portfolio', weight, 'portfolio');
  const n = m.filter((x) => x[field]).length;
  return check(id, label, grade(n / m.length), `${n} von ${m.length} Modellen mit Angabe`, weight, 'portfolio');
}

function sov1(ctx) {
  const providers = new Set(ctx.portfolio.map((m) => m.provider).filter(Boolean));
  const gw = ctx.gateways.map((g) => GATEWAY_PRODUCTS.find((p) => p.key === g.spec?.product)).filter(Boolean);
  const gwOpen = gw.length ? (gw.every((g) => g.open === true) ? 'pass' : gw.some((g) => g.open === false) ? 'warn' : 'unknown') : 'unknown';
  return [
    managedExposure(ctx),
    openWeights(ctx, 2),
    ctx.portfolio.length
      ? check('diversity', 'Modelle mehrerer Anbieter', providers.size >= 2 ? 'pass' : 'warn', providers.size ? `${plural(providers.size, 'Anbieter', 'Anbieter')}: ${[...providers].join(', ')}` : 'Anbieter der Modelle nicht angegeben', 1, 'portfolio')
      : check('diversity', 'Modelle mehrerer Anbieter', 'unknown', 'Keine Modelle im Portfolio', 1, 'portfolio'),
    check('gateway-open', 'Gateway quelloffen und austauschbar', gwOpen, gw.length ? gw.map((g) => g.label).join(', ') : 'Kein Gateway im Inventar', 1),
  ];
}

function sov2(ctx) {
  const dcs = ctx.datacenters;
  const located = dcs.filter((d) => d.spec?.country);
  const us = dcs.filter((d) => jurisdictionOf(d) === 'us');
  const foreign = ctx.managed.filter((m) => provider(m)?.jurisdiction === 'us');
  return [
    !located.length
      ? check('location', 'Standort in der EU bzw. im EWR', 'unknown', dcs.length ? 'Kein Land am Rechenzentrum angegeben' : 'Kein Rechenzentrum im Inventar', 3)
      : check('location', 'Standort in der EU bzw. im EWR', grade(share(located.filter(isEu).length, located.length)), located.map((d) => `${d.name}: ${d.spec.country}${d.spec.region ? ` (${d.spec.region})` : ''}`).join('; '), 3),
    !dcs.length
      ? check('jurisdiction', 'Betreiber unterliegt keinem Drittstaatenzugriff', 'unknown', 'Kein Rechenzentrum im Inventar', 3)
      : check('jurisdiction', 'Betreiber unterliegt keinem Drittstaatenzugriff', us.length ? 'fail' : dcs.every((d) => ['self', 'eu'].includes(jurisdictionOf(d))) ? 'pass' : 'warn', us.length ? `Anbieter mit Sitz in den USA (z. B. CLOUD Act): ${names(us)}` : 'Eigener Betrieb oder Anbieter mit Sitz in der EU', 3),
    !ctx.managed.length
      ? check('managed-law', 'Externe KI-Dienste unterliegen EU-Recht', ctx.inference.length ? 'pass' : 'unknown', ctx.inference.length ? 'Keine externen KI-Dienste' : 'Kein Inferenzserver im Inventar', 2)
      : check('managed-law', 'Externe KI-Dienste unterliegen EU-Recht', foreign.length ? 'fail' : 'warn', foreign.length ? `Anbieter mit Sitz in den USA: ${names(foreign)}` : `Rechtsraum nicht eindeutig: ${names(ctx.managed)}`, 2),
    metadataShare(ctx, 'license', 'Lizenzen der Modelle bekannt', 'license', 1),
  ];
}

const lookup = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const reuse = (checks, id, weight) => ({ ...checks[id], weight });

function sov3(ctx) {
  const sec = lookup(securityChecks(ctx));
  return [reuse(sec, 'network', 3), managedExposure(ctx), sec.exposure ? reuse(sec, 'exposure', 1.5) : null, openWeights(ctx, 2), metadataShare(ctx, 'origin', 'Herkunft der Modelle dokumentiert', 'origin', 1)].filter(Boolean);
}

function sov4(ctx) {
  const dcs = ctx.datacenters;
  const prod = lookup(productionChecks(ctx));
  const k = ctx.clusters;
  const kStatus = (c) => (c.spec?.operation === 'managed' ? (c.spec.certifications?.length ? 'warn' : 'fail') : 'pass');
  const rank = { pass: 2, warn: 1, fail: 0 };
  const kWorst = k.map(kStatus).sort((a, b) => rank[a] - rank[b])[0];
  return [
    !dcs.length
      ? check('operation', 'Kontrolle über den Betrieb', 'unknown', 'Kein Rechenzentrum im Inventar', 2)
      : check('operation', 'Kontrolle über den Betrieb', dcs.every((d) => d.spec?.on_prem) ? 'pass' : dcs.some((d) => jurisdictionOf(d) === 'us') ? 'fail' : 'warn', dcs.map((d) => `${d.name}: ${d.spec?.on_prem ? 'eigener Betrieb' : (HOSTING_PROVIDERS.find((p) => p.key === d.spec?.provider)?.label ?? 'Anbieter')}`).join('; '), 2),
    !k.length
      ? check('kubernetes', 'Kubernetes selbst betrieben oder zertifiziert', 'unknown', 'Kein Kubernetes im Inventar', 1.5)
      : check('kubernetes', 'Kubernetes selbst betrieben oder zertifiziert', kWorst, k.map((c) => `${c.name}: ${c.spec?.operation === 'managed' ? 'Managed' : 'selbst betrieben'}${c.spec?.certifications?.length ? ` (${c.spec.certifications.join(', ')})` : ''}`).join('; '), 1.5),
    reuse(prod, 'health', 1),
    prod.metrics ? reuse(prod, 'metrics', 1) : check('metrics', 'Metriken angebunden', 'unknown', 'Keine GPUs oder selbst betriebenen Inferenzserver', 1),
    reuse(prod, 'schedule', 1),
  ];
}

function sov5(ctx) {
  const selfProviders = ctx.selfHosted.map(provider).filter(Boolean);
  const live = (ctx.status?.components ?? []).filter((c) => c.status === 'up');
  return [
    metadataShare(ctx, 'revision', 'Revision bzw. Hash der Modelle festgehalten', 'revision', 2),
    metadataShare(ctx, 'license', 'Lizenzen der Modelle bekannt', 'license', 1),
    selfProviders.length
      ? check('serving-open', 'Quelloffene Inferenz-Software', grade(selfProviders.filter((p) => p.open === true).length / selfProviders.length), selfProviders.map((p) => p.label).join(', '), 1)
      : check('serving-open', 'Quelloffene Inferenz-Software', 'unknown', 'Keine selbst betriebenen Inferenzserver', 1),
    live.length
      ? check('versions', 'Versionen der Komponenten bekannt', grade(live.filter((c) => c.version).length / live.length), `${live.filter((c) => c.version).length} von ${live.length} Komponenten melden ihre Version`, 1, 'status')
      : check('versions', 'Versionen der Komponenten bekannt', 'unknown', 'Keine abfragbare Komponente', 1, 'status'),
  ];
}

function sov6(ctx) {
  const sec = lookup(securityChecks(ctx));
  const gw = ctx.gateways.map((g) => GATEWAY_PRODUCTS.find((p) => p.key === g.spec?.product)).filter(Boolean);
  const selfProviders = ctx.selfHosted.map(provider).filter(Boolean);
  const backends = new Set(ctx.inference.map((i) => i.spec?.provider).filter(Boolean));
  return [
    openWeights(ctx, 2),
    selfProviders.length
      ? check('serving-open', 'Quelloffene Inferenz-Software', grade(selfProviders.filter((p) => p.open === true).length / selfProviders.length), selfProviders.map((p) => p.label).join(', '), 2)
      : check('serving-open', 'Quelloffene Inferenz-Software', 'unknown', 'Keine selbst betriebenen Inferenzserver', 2),
    gw.length
      ? check('gateway-open', 'Gateway quelloffen und austauschbar', gw.every((g) => g.open === true) ? 'pass' : gw.some((g) => g.open === false) ? 'warn' : 'unknown', gw.map((g) => g.label).join(', '), 1.5)
      : check('gateway-open', 'Gateway quelloffen und austauschbar', 'unknown', 'Kein Gateway im Inventar', 1.5),
    ctx.inference.length
      ? check('portable', 'Wechsel des Anbieters möglich', backends.size >= 2 ? 'pass' : 'warn', backends.size ? `${plural(backends.size, 'Inferenz-Anbieter', 'Inferenz-Anbieter')}: ${[...backends].join(', ')}` : 'Anbieter nicht angegeben', 1)
      : check('portable', 'Wechsel des Anbieters möglich', 'unknown', 'Kein Inferenzserver im Inventar', 1),
    reuse(sec, 'gateway', 1),
  ];
}

function sov7(ctx) {
  const sec = lookup(securityChecks(ctx));
  const ids = ['tls', 'access', 'security-tests', 'network', 'findings', 'mcp-auth', 'exposure', 'dc-cert', 'iam', 'observability'];
  return ids.filter((id) => sec[id]).map((id) => sec[id]);
}

function sov8(ctx) {
  const dcs = ctx.datacenters;
  const known = dcs.filter((d) => d.spec?.renewable_energy !== null && d.spec?.renewable_energy !== undefined);
  const pue = dcs.filter((d) => typeof d.spec?.pue === 'number');
  const green = dcs.filter((d) => hasCert(d.spec?.certifications, /14001|EMAS|Blauer Engel/i));
  const migBundled = new Set(ctx.interconnects.flatMap((i) => (i.spec?.bundles ?? []).filter((b) => b.mode === 'mig').flatMap((b) => b.gpu_ids)));
  const mig = ctx.gpus.filter((g) => g.spec?.mig?.enabled || migBundled.has(g.id));
  return [
    known.length
      ? check('renewable', 'Strom aus erneuerbaren Quellen', grade(share(known.filter((d) => d.spec.renewable_energy).length, dcs.length)), known.map((d) => `${d.name}: ${d.spec.renewable_energy ? 'ja' : 'nein'}`).join('; '), 2)
      : check('renewable', 'Strom aus erneuerbaren Quellen', 'unknown', dcs.length ? 'Keine Angabe am Rechenzentrum' : 'Kein Rechenzentrum im Inventar', 2),
    pue.length
      ? check('pue', 'Energieeffizienz (PUE)', pue.every((d) => d.spec.pue <= 1.3) ? 'pass' : pue.every((d) => d.spec.pue <= 1.6) ? 'warn' : 'fail', pue.map((d) => `${d.name}: ${d.spec.pue}`).join('; '), 2)
      : check('pue', 'Energieeffizienz (PUE)', 'unknown', 'Kein PUE-Wert angegeben', 2),
    dcs.length
      ? check('env-cert', 'Umwelt-Zertifizierung des Rechenzentrums', green.length === dcs.length ? 'pass' : green.length ? 'warn' : 'fail', green.length ? green.map((d) => d.name).join(', ') : 'ISO 14001, EMAS oder Blauer Engel nicht angegeben', 1)
      : check('env-cert', 'Umwelt-Zertifizierung des Rechenzentrums', 'unknown', 'Kein Rechenzentrum im Inventar', 1),
    ctx.gpus.length
      ? check('gpu-share', 'GPUs werden geteilt (MIG)', mig.length ? 'pass' : 'warn', mig.length ? `${plural(mig.length, 'GPU', 'GPUs')} mit MIG` : 'Keine GPU mit MIG: kleine Modelle belegen ganze GPUs', 0.5)
      : check('gpu-share', 'GPUs werden geteilt (MIG)', 'unknown', 'Keine GPU im Inventar', 0.5),
  ];
}

const GOAL_CHECKS = { 'SOV-1': sov1, 'SOV-2': sov2, 'SOV-3': sov3, 'SOV-4': sov4, 'SOV-5': sov5, 'SOV-6': sov6, 'SOV-7': sov7, 'SOV-8': sov8 };

// Prüfpunkte eines Ziels: Inventar und Portfolio plus die Tests, die dem Ziel über ihre Kategorie zugeordnet sind.
export function goalChecks(ctx, key) {
  const checks = (GOAL_CHECKS[key]?.(ctx) ?? []).filter(Boolean);
  const keys = new Set(ctx.goalLinks.filter((l) => l.goal === key).map((l) => l.template_key));
  // Der Netzwerk- und Sicherheitsblock deckt bereits Tests ab; hier kommen die übrigen zugeordneten Tests dazu.
  const rows = ctx.results.filter((r) => keys.has(r.template_key));
  if (rows.length) checks.push(testCheck('linked-tests', 'Zugeordnete Tests bestanden', rows, 3));
  return checks;
}

// Bewertung eines Ziels: abgeleitete Stufe aus dem Prüfpunkt-Wert, bei einem fehlgeschlagenen Punkt mit Gewicht ≥ 3 höchstens SEAL-2.
export function evaluateGoal(ctx, goal, sov) {
  const summary = summarize(goalChecks(ctx, goal.key));
  let derived = summary.level === 'incomplete' ? null : sealFromRate(summary.score / 100);
  const blocker = summary.checks.find((c) => c.status === 'fail' && c.weight >= 3);
  if (derived !== null && blocker && derived > 2) derived = 2;
  const override = sov?.overrides?.[goal.key] ?? null;
  const effective = override ? Number(override.level) : derived;
  const minLevel = Number(sov?.min_level ?? 0);
  return {
    key: goal.key,
    name: goal.name,
    derived,
    override,
    effective,
    score: summary.score,
    coverage: summary.coverage,
    capped_by: derived !== null && blocker && derived === 2 ? blocker.label : null,
    checks: summary.checks,
    status: effective === null ? 'unrated' : effective >= minLevel ? 'ok' : 'gap',
  };
}

// Top-Empfehlungen: jeder offene Prüfpunkt wird testweise als bestanden gerechnet; Rang nach Gewinn an SEAL-Stufen und Punktwert über alle Ziele.
export function recommendations(ctx, sov, limit = 5) {
  const perGoal = ctx.goals.map((g) => {
    const checks = goalChecks(ctx, g.key);
    const base = evaluateGoal(ctx, g, sov);
    return { goal: g, checks, base };
  });
  const open = new Map();
  for (const { goal, checks } of perGoal) {
    for (const c of checks) {
      if (c.status === 'pass' || c.status === 'info') continue;
      const key = c.id;
      if (!open.has(key)) open.set(key, { id: c.id, label: c.label, detail: c.detail, status: c.status, weight: c.weight, goals: [] });
      open.get(key).goals.push(goal.key);
    }
  }
  const list = [];
  for (const rec of open.values()) {
    const effects = [];
    for (const { goal, checks, base } of perGoal) {
      if (!rec.goals.includes(goal.key)) continue;
      const after = summarize(checks.map((c) => (c.id === rec.id ? { ...c, status: 'pass' } : c)));
      let derived = after.level === 'incomplete' ? null : sealFromRate(after.score / 100);
      const blocker = after.checks.find((c) => c.status === 'fail' && c.weight >= 3);
      if (derived !== null && blocker && derived > 2) derived = 2;
      effects.push({
        goal: goal.key,
        name: goal.name,
        from: base.derived,
        to: derived,
        levels: (derived ?? 0) - (base.derived ?? 0),
        points: Math.max(0, (after.score ?? 0) - (base.score ?? 0)),
      });
    }
    const levels = effects.reduce((n, e) => n + Math.max(0, e.levels), 0);
    const points = effects.reduce((n, e) => n + e.points, 0);
    list.push({ ...rec, effects, levels, points, rank: levels * 1000 + points + rec.weight });
  }
  return list
    .filter((r) => r.points > 0 || r.levels > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ rank, ...r }) => r);
}

async function loadPlatform(tenantId, platformId) {
  return one('select id, name, description, environment, locked, locked_reason, sovereignty from platforms where id = $1 and tenant_id = $2', [platformId, tenantId]);
}

function sovereigntyOf(ctx) {
  const sov = ctx.platform.sovereignty ?? {};
  const goals = ctx.goals.map((g) => evaluateGoal(ctx, g, sov));
  const rated = goals.filter((g) => g.effective !== null);
  const overall = rated.length ? Math.min(...rated.map((g) => g.effective)) : null;
  return { min_level: Number(sov.min_level ?? 0), goals, overall, seal: SEAL };
}

// Gesamte Einstufung: Sicherheit, Produktionsreife und Souveränität.
export async function assess(tenantId, platformId) {
  const platform = await loadPlatform(tenantId, platformId);
  if (!platform) return null;
  const ctx = await loadContext(tenantId, platform);
  return {
    platform: { id: platform.id, name: platform.name, environment: platform.environment },
    components: ctx.endpoints.length,
    security: summarize(securityChecks(ctx)),
    production: summarize(productionChecks(ctx)),
    sovereignty: sovereigntyOf(ctx),
    recommendations: recommendations(ctx, platform.sovereignty ?? {}),
  };
}

export async function sovereignty(tenantId, platformId) {
  const platform = await loadPlatform(tenantId, platformId);
  if (!platform) return null;
  const ctx = await loadContext(tenantId, platform);
  return { platform: { id: platform.id, name: platform.name, environment: platform.environment }, ...sovereigntyOf(ctx) };
}
