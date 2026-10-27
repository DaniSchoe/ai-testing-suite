// Netzwerk-Isolation (Egress): ruft Seiten aus dem Internet auf und prüft, ob die Plattform wirklich abgeschottet (Air-Gapped) ist
// bzw. ob sensible Seiten geblockt werden. Der Test läuft aus dem Netz der Suite und beurteilt damit deren Ausgangsverkehr.
import { lookup } from 'node:dns/promises';

const t = (url, label, group, expect = 'blocked') => ({ url, label, group, expect });

export const DEFAULT_TARGETS = [
  t('https://www.wikipedia.org', 'Wikipedia', 'internet'),
  t('https://example.com', 'example.com', 'internet'),
  t('https://github.com', 'GitHub', 'internet'),
  t('https://pypi.org', 'PyPI (Paketquelle)', 'internet'),
  t('https://registry.npmjs.org', 'npm-Registry (Paketquelle)', 'internet'),
  t('https://huggingface.co', 'Hugging Face (Modellquelle)', 'internet'),
  t('https://hub.docker.com', 'Docker Hub (Imagequelle)', 'internet'),
  t('https://api.openai.com', 'OpenAI API', 'sensitive'),
  t('https://api.anthropic.com', 'Anthropic API', 'sensitive'),
  t('https://pastebin.com', 'Pastebin (Datenabfluss)', 'sensitive'),
  t('https://www.dropbox.com', 'Dropbox (Datenabfluss)', 'sensitive'),
  t('https://wetransfer.com', 'WeTransfer (Datenabfluss)', 'sensitive'),
];

async function probe(target, { timeoutMs, blockStatus }) {
  const host = new URL(target.url).hostname;
  const out = { ...target, host, dns: null, http_status: null, reachable: false, reason: null, latency_ms: null };
  const t0 = performance.now();
  try {
    await lookup(host);
    out.dns = true;
  } catch (err) {
    out.dns = false;
    out.reason = `DNS: ${err.code ?? err.message}`;
    out.latency_ms = Math.round(performance.now() - t0);
    return out;
  }
  try {
    const res = await fetch(target.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    out.http_status = res.status;
    // Eine Sperrseite einer Firewall oder eines Proxys (403, 407, 451) gilt als geblockt.
    if (blockStatus.includes(res.status)) out.reason = `HTTP ${res.status} (Sperre)`;
    else out.reachable = true;
    await res.body?.cancel().catch(() => {});
  } catch (err) {
    const code = err.cause?.code ?? err.name;
    out.reason = code === 'TimeoutError' || code === 'AbortError' ? 'Zeitüberschreitung' : `Verbindung: ${code ?? err.message}`;
  }
  out.latency_ms = Math.round(performance.now() - t0);
  return out;
}

export default {
  type: 'network',
  label: 'Netzwerk-Isolation',
  description: 'Ruft Seiten aus dem Internet auf und prüft, ob eine Air-Gapped-Umgebung vorliegt bzw. sensible Seiten geblockt werden.',
  modelMode: 'none',
  platformLevel: true,
  defaults: { timeoutMs: 5000, blockStatus: [403, 407, 451], targets: DEFAULT_TARGETS },
  async run(ctx) {
    const cfg = ctx.config;
    const targets = (cfg.targets?.length ? cfg.targets : DEFAULT_TARGETS).map((x) => ({ expect: 'blocked', group: 'internet', ...x }));
    const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs) || 5000, 500), 30_000);
    const blockStatus = (cfg.blockStatus ?? [403, 407, 451]).map(Number);
    const checks = [];
    // Bis zu vier Ziele gleichzeitig, damit auch Zeitüberschreitungen den Test nicht ausdehnen.
    for (let i = 0; i < targets.length; i += 4) {
      checks.push(...(await Promise.all(targets.slice(i, i + 4).map((x) => probe(x, { timeoutMs, blockStatus })))));
    }
    for (const c of checks) c.ok = c.expect === 'reachable' ? c.reachable : !c.reachable;
    const unexpectedReachable = checks.filter((c) => c.expect === 'blocked' && c.reachable);
    const unexpectedBlocked = checks.filter((c) => c.expect === 'reachable' && !c.reachable);
    const sensitive = checks.filter((c) => c.group === 'sensitive');
    for (const c of unexpectedReachable) await ctx.log('warn', `Erreichbar, obwohl geblockt sein sollte: ${c.url} (HTTP ${c.http_status})`);
    const reachable = checks.filter((c) => c.reachable).length;
    return {
      status: unexpectedReachable.length || unexpectedBlocked.length ? 'failed' : 'passed',
      score: checks.length ? checks.filter((c) => c.ok).length / checks.length : 0,
      metrics: {
        targets: checks.length,
        reachable,
        blocked: checks.length - reachable,
        unexpected_reachable: unexpectedReachable.length,
        unexpected_blocked: unexpectedBlocked.length,
        sensitive_reachable: sensitive.filter((c) => c.reachable).length,
        air_gapped: reachable === 0 ? 1 : 0,
      },
      details: { checks, air_gapped: reachable === 0 },
    };
  },
};
