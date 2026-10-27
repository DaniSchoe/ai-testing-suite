import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cleanSpec, validateLinks, validateSpecRefs } from '../src/inventorySpec.js';
import { GPU_TYPES, presets } from '../src/inventory.js';
import { evaluateGoal, summarize } from '../src/assessment.js';
import network from '../src/testtypes/network.js';

test('Inventar: GPU-Typen und Voreinstellungen', () => {
  for (const key of ['h100', 'h200', 'rtx-pro-6000', 'b100', 'b200', 'b300']) assert.ok(GPU_TYPES[key], key);
  assert.ok(presets().hosting_providers.some((p) => p.key === 'on_prem'));
});

test('Inventar: Rechenzentrum und Kubernetes werden bereinigt', () => {
  const dc = cleanSpec('datacenter', { provider: 'on_prem', country: 'de', certifications: ['ISO 27001', 'ISO 27001', 'BSI C5'], pue: '1.3', unbekannt: 1 });
  assert.deepEqual(dc.certifications, ['ISO 27001', 'BSI C5']);
  assert.equal(dc.country, 'DE');
  assert.equal(dc.on_prem, true);
  assert.equal(dc.pue, 1.3);
  assert.equal(dc.unbekannt, undefined);
  assert.throws(() => cleanSpec('datacenter', { provider: 'gibtsnicht' }), /Hosting-Anbieter/);
  assert.equal(cleanSpec('kubernetes', { operation: 'managed', distribution: 'eks' }).operation, 'managed');
});

test('Inventar: GPU mit MIG, Slices und eigener Typ', () => {
  const ok = cleanSpec('gpu', { gpu_type: 'h100', mig: { enabled: true, layout: [{ profile: '3g.40gb', slices: 3, memory_gb: 40 }, { profile: '4g.40gb', slices: 4, memory_gb: 40 }] } });
  assert.equal(ok.memory_gb, 80);
  assert.equal(ok.mig.layout.length, 2);
  assert.throws(() => cleanSpec('gpu', { gpu_type: 'h100', mig: { enabled: true, layout: [{ profile: 'a', slices: 7 }, { profile: 'b', slices: 1 }] } }), /höchstens 7/);
  assert.throws(() => cleanSpec('gpu', { gpu_type: 'rtx-pro-6000', mig: { enabled: true, layout: [{ profile: 'a', slices: 4 }, { profile: 'b', slices: 1 }] } }), /höchstens 4/);
  assert.throws(() => cleanSpec('gpu', { gpu_type: 'custom', custom: { name: 'X' } }), /Speicher/);
  assert.throws(() => cleanSpec('gpu', { gpu_type: 'custom', custom: { name: 'X', memory_gb: 48 }, mig: { enabled: true, layout: [{ profile: 'a', slices: 1 }] } }), /kein MIG/);
  assert.equal(cleanSpec('gpu', { gpu_type: 'custom', custom: { name: 'MI300X', memory_gb: 192 } }).custom.name, 'MI300X');
});

test('Inventar: Inferenzserver selbst betrieben oder Managed Service', () => {
  assert.equal(cleanSpec('llm', { provider: 'vllm' }).hosting, 'self');
  assert.equal(cleanSpec('llm', { provider: 'anthropic' }).hosting, 'managed');
  assert.throws(() => cleanSpec('llm', { provider: 'nix' }), /Anbieter/);
});

test('Topologie: erlaubte Zuordnungen und MIG-Instanzen', () => {
  const byId = new Map([
    ['d', { id: 'd', name: 'RZ', kind: 'datacenter' }],
    ['k', { id: 'k', name: 'K8s', kind: 'kubernetes' }],
    ['g', { id: 'g', name: 'GPU', kind: 'gpu', spec: { mig: { enabled: true, layout: [{ profile: 'a' }, { profile: 'b' }] } } }],
    ['i', { id: 'i', name: 'vLLM', kind: 'llm' }],
  ]);
  const links = validateLinks(
    [
      { kind: 'hosted_in', from_id: 'k', to_id: 'd' },
      { kind: 'cluster', from_id: 'g', to_id: 'k' },
      { kind: 'runs_on', from_id: 'i', to_id: 'g', data: { mig_slice: 1 } },
      { kind: 'runs_on', from_id: 'i', to_id: 'g', data: { mig_slice: 1 } },
    ],
    byId,
  );
  assert.equal(links.length, 3, 'Doppelte Zuordnung entfällt');
  assert.deepEqual(links[2].data, { mig_slice: 1 });
  assert.throws(() => validateLinks([{ kind: 'runs_on', from_id: 'i', to_id: 'd' }], byId), /Ungültige Zuordnung/);
  assert.throws(() => validateLinks([{ kind: 'runs_on', from_id: 'i', to_id: 'g', data: { mig_slice: 2 } }], byId), /MIG-Instanz/);
  assert.throws(() => validateLinks([{ kind: 'runs_on', from_id: 'i', to_id: 'x' }], byId), /außerhalb/);
});

test('Server, Interconnect-Bundles und Verweise der Topologie', () => {
  const server = cleanSpec('server', { server_type: 'gpu', cpu_cores: '64', ram_gb: 512 });
  assert.equal(server.server_type, 'gpu');
  assert.equal(server.cpu_cores, 64);
  assert.throws(() => cleanSpec('server', { server_type: 'tpu' }), /Server-Art/);
  assert.throws(() => cleanSpec('interconnect', { type: 'nvlink', bundles: [{ name: 'A', mode: 'nvlink', gpu_ids: ['g1'] }] }), /mindestens zwei/);
  assert.throws(() => cleanSpec('interconnect', { type: 'nvlink', bundles: [{ name: 'A', mode: 'mig', gpu_ids: ['g1', 'g2'], profile: '1g', slices: 1 }] }), /genau eine/);
  const ic = cleanSpec('interconnect', { type: 'nvlink', bundles: [{ id: 'x', name: 'Verbund', mode: 'nvlink', gpu_ids: ['g1', 'g2', 'g1'] }] });
  assert.deepEqual(ic.bundles[0].gpu_ids, ['g1', 'g2']);
  const byId = new Map([
    ['s', { id: 's', name: 'S1', kind: 'server' }],
    ['g1', { id: 'g1', name: 'G1', kind: 'gpu', spec: { gpu_type: 'h100' } }],
    ['g2', { id: 'g2', name: 'G2', kind: 'gpu', spec: { gpu_type: 'h100' } }],
    ['i', { id: 'i', name: 'vLLM', kind: 'llm' }],
    ['n', { id: 'n', name: 'NVL', kind: 'interconnect', spec: ic }],
    ['k', { id: 'k', name: 'K8s', kind: 'kubernetes', spec: { nodes: [{ server_id: 's', role: 'worker' }] } }],
  ]);
  const links = validateLinks(
    [
      { kind: 'hosted_in', from_id: 'g1', to_id: 's' },
      { kind: 'runs_on', from_id: 'i', to_id: 'n', data: { bundle_id: 'x' } },
    ],
    byId,
  );
  assert.deepEqual(links[1].data, { bundle_id: 'x' });
  assert.throws(() => validateLinks([{ kind: 'runs_on', from_id: 'i', to_id: 'n', data: { bundle_id: 'y' } }], byId), /Bundle/);
  assert.doesNotThrow(() => validateSpecRefs(byId.get('k'), byId));
  assert.throws(() => validateSpecRefs({ id: 'k', name: 'K', kind: 'kubernetes', spec: { nodes: [{ server_id: 'g1', role: 'worker' }] } }, byId), /kein Server/);
  const mig = (id, slices) => ({ id, name: id, mode: 'mig', gpu_ids: ['g1'], profile: 'p', slices });
  assert.throws(() => validateSpecRefs({ id: 'n', name: 'N', kind: 'interconnect', spec: { bundles: [mig('a', 5), mig('b', 3)] } }, byId), /höchstens 7/);
});

test('Einstufung: Punktzahl, Abdeckung und Stufe', () => {
  const c = (status, weight = 1) => ({ id: status + weight, label: status, status, detail: '', weight });
  assert.equal(summarize([c('pass'), c('pass', 2)]).level, 'good');
  assert.equal(summarize([c('pass'), c('fail')]).score, 50);
  assert.equal(summarize([c('pass'), c('warn')]).score, 75);
  const unknown = summarize([c('pass'), c('unknown', 3), c('unknown', 2)]);
  assert.equal(unknown.level, 'incomplete', 'Unter 40 % Abdeckung gibt es keine Einstufung');
});

test('Souveränitätsziel: Überschreiben ersetzt die abgeleitete Stufe, Blocker begrenzt auf SEAL-2', () => {
  const ctx = {
    platform: { sovereignty: {} },
    endpoints: [], links: [], routes: [], results: [], portfolio: [], findings: {}, audits: [], goalLinks: [], status: null,
    datacenters: [], clusters: [], gpus: [], interconnects: [], inference: [], selfHosted: [], managed: [], gateways: [], byId: new Map(),
  };
  const goal = { key: 'SOV-8', name: 'Ökologische Nachhaltigkeit' };
  const plain = evaluateGoal(ctx, goal, { min_level: 2, overrides: {} });
  assert.equal(plain.derived, null);
  assert.equal(plain.status, 'unrated');
  const over = evaluateGoal(ctx, goal, { min_level: 2, overrides: { 'SOV-8': { level: 3, reason: 'Zertifikat' } } });
  assert.equal(over.effective, 3);
  assert.equal(over.status, 'ok');
  const eu = { id: 'd', name: 'RZ', kind: 'datacenter', spec: { provider: 'hetzner', country: 'DE', certifications: ['ISO 27001'] } };
  const us = evaluateGoal({ ...ctx, datacenters: [{ ...eu, spec: { provider: 'aws', country: 'US' } }] }, { key: 'SOV-2', name: 'Recht' }, {});
  assert.ok(us.checks.find((x) => x.id === 'jurisdiction').status === 'fail');
});

test('Netzwerk-Test: erreichbare Seite verletzt die Erwartung, Sperrseite gilt als geblockt', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === '/blocked' ? 403 : 200;
    res.end('x');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const ctx = { config: { ...network.defaults, targets: [{ url: `${base}/open`, label: 'offen', group: 'sensitive' }, { url: `${base}/blocked`, label: 'gesperrt', group: 'internet' }] }, log: async (...a) => logs.push(a) };
  const res = await network.run(ctx);
  server.close();
  assert.equal(res.status, 'failed');
  assert.equal(res.metrics.unexpected_reachable, 1);
  assert.equal(res.metrics.blocked, 1);
  assert.equal(res.metrics.sensitive_reachable, 1);
  assert.equal(res.metrics.air_gapped, 0);
  const closed = await network.run({ config: { ...network.defaults, targets: [{ url: 'http://127.0.0.1:1', label: 'zu', group: 'internet' }] }, log: async () => {} });
  assert.equal(closed.status, 'passed');
  assert.equal(closed.metrics.air_gapped, 1);
});
