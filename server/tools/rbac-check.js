// End-to-End-Prüfung von Rollen, Berechtigungen und Teams gegen einen laufenden Server im Dev-Modus.
// Aufruf: AUTH_MODE=dev node src/server.js & node tools/rbac-check.js [http://localhost:8080]
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8080';
const suffix = Date.now().toString(36);

async function login(as) {
  const res = await fetch(`${base}/auth/login${as ? `?as=${as}` : ''}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

const step = (name) => console.log(`✓ ${name}`);

const admin = await login();
const me = (await admin('/api/me')).data;
assert.equal(me.is_admin, true, 'dev-admin ist Admin');
step('Admin per ADMIN_EMAILS');

const bobName = `bob-${suffix}`;
const bob = await login(bobName);
const bobMe = (await bob('/api/me')).data;
assert.deepEqual(bobMe.roles.map((r) => r.key), ['viewer'], 'neuer User erhält Standardrolle');
assert.equal((await bob('/api/runs', { method: 'POST', body: { kind: 'all' } })).status, 403);
assert.equal((await bob('/api/users')).status, 403);
step('Neuer User: Standardrolle Betrachter, darf nichts starten oder verwalten');

const roles = (await admin('/api/roles')).data;
const role = (key) => roles.find((r) => r.key === key);
const team = await admin('/api/teams', { method: 'POST', body: { name: `Team ${suffix}`, memberIds: [bobMe.id] } });
assert.equal(team.status, 200);
assert.equal((await admin('/api/teams', { method: 'POST', body: { name: `Team ${suffix}` } })).status, 409);
step('Team anlegen, doppelter Name gibt 409');

let r = await admin(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [role('tester').id] } });
assert.deepEqual(r.data.roles.map((x) => x.key), ['tester']);
assert.deepEqual(r.data.teams.map((x) => x.id), [team.data.id]);
r = await bob('/api/runs', { method: 'POST', body: { kind: 'single', testIds: [(await bob('/api/tests')).data[0].id] } });
assert.equal(r.status, 200, 'Tester darf Läufe starten');
step('Rolle Tester zuweisen, Lauf starten');

// Ohne results.view_all: nur eigene Läufe und die des eigenen Teams.
const limited = await admin('/api/roles', {
  method: 'POST',
  body: { name: `Teamleser ${suffix}`, permissions: ['suite.view', 'users.manage'] },
});
assert.equal(limited.status, 200);
await admin(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [limited.data.id] } });
assert.equal((await bob('/api/dashboard')).data.scope, 'me', 'ohne results.view_all kein globales Dashboard');
assert.equal((await bob(`/api/dashboard?scope=team&teamId=${team.data.id}`)).data.scope, 'team');
const otherTeam = await admin('/api/teams', { method: 'POST', body: { name: `Fremd ${suffix}` } });
assert.equal((await bob(`/api/dashboard?scope=team&teamId=${otherTeam.data.id}`)).status, 403);
const adminRun = await admin('/api/runs', { method: 'POST', body: { kind: 'single', testIds: [(await admin('/api/tests')).data[0].id] } });
assert.equal((await bob(`/api/runs/${adminRun.data.id}`)).status, 404, 'fremder Lauf ohne gemeinsames Team unsichtbar');
step('Sichtbarkeit: eigene, Team, global nur mit results.view_all');

assert.equal((await bob(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [limited.data.id, role('admin').id] } })).status, 403);
assert.equal((await bob(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [limited.data.id, role('tester').id] } })).status, 403);
assert.equal((await bob(`/api/roles/${limited.data.id}`, { method: 'PUT', body: { name: 'x', permissions: ['roles.manage'] } })).status, 403);
step('Keine Rechteausweitung: Admin-Rolle und fremde Berechtigungen nicht vergebbar');

const carol = await admin('/api/users', {
  method: 'POST',
  body: { email: `Carol-${suffix}@Localhost`, display_name: 'Carol', teamIds: [team.data.id] },
});
assert.equal(carol.data.pending, true);
const carolSession = await login(`carol-${suffix}`);
const carolMe = (await carolSession('/api/me')).data;
assert.equal(carolMe.id, carol.data.id, 'Login übernimmt den vorab angelegten User');
assert.deepEqual(carolMe.teams.map((t) => t.id), [team.data.id]);
step('Vorab per E-Mail angelegter User wird beim Login übernommen');

await admin(`/api/users/${bobMe.id}`, { method: 'PUT', body: { disabled: true } });
assert.equal((await bob('/api/tests')).status, 403);
assert.equal((await admin(`/api/users/${me.id}`, { method: 'PUT', body: { disabled: true } })).status, 400);
step('Sperren wirkt sofort, eigenes Konto nicht sperrbar');

assert.equal((await admin(`/api/roles/${role('admin').id}`, { method: 'DELETE' })).status, 400);
step('Admin-Rolle nicht löschbar');
console.log('RBAC-Prüfung erfolgreich');
