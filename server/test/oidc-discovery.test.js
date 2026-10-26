import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Fake-Keycloak, der einen festen Issuer meldet (unabhängig von der abgefragten URL).
function fakeKeycloak(reportedIssuer) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      issuer: reportedIssuer(server.address().port),
      authorization_endpoint: 'http://x/auth',
      token_endpoint: 'http://x/token',
      jwks_uri: 'http://x/jwks',
    }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// config.js ist ein Singleton: Werte pro Test direkt setzen; auth.js frisch laden (eigener Discovery-Cache).
async function loadAuth({ OIDC_ISSUER_URL, OIDC_TRUST_DISCOVERED_ISSUER }) {
  process.env.AUTH_MODE = 'oidc';
  process.env.APP_SECRET = 'x'.repeat(32);
  const { config } = await import('../src/config.js');
  Object.assign(config.auth, {
    issuer: OIDC_ISSUER_URL,
    clientId: 'c',
    clientSecret: 's',
    allowInsecure: true,
    trustDiscoveredIssuer: OIDC_TRUST_DISCOVERED_ISSUER === 'true',
  });
  return import(`../src/auth.js?${Math.random()}`);
}

test('Discovery: abschließender Slash in OIDC_ISSUER_URL ist egal', async () => {
  const kc = await fakeKeycloak((p) => `http://127.0.0.1:${p}/realms/r`);
  const port = kc.address().port;
  const { getOidcConfigForTest } = await loadAuth({ OIDC_ISSUER_URL: `http://127.0.0.1:${port}/realms/r/`, OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' });
  assert.ok(await getOidcConfigForTest());
  kc.close();
});

test('Discovery: abweichender Issuer liefert verständlichen Fehler mit beiden Werten', async () => {
  const kc = await fakeKeycloak((p) => `https://kc.example.com/realms/r`);
  const port = kc.address().port;
  const { getOidcConfigForTest } = await loadAuth({ OIDC_ISSUER_URL: `http://127.0.0.1:${port}/realms/r`, OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_TRUST_DISCOVERED_ISSUER: '' });
  await assert.rejects(getOidcConfigForTest(), /Issuer "https:\/\/kc\.example\.com\/realms\/r"/);
  kc.close();
});

test('Discovery: OIDC_TRUST_DISCOVERED_ISSUER übernimmt den gemeldeten Issuer', async () => {
  const kc = await fakeKeycloak(() => `https://kc.example.com/realms/r`);
  const port = kc.address().port;
  const { getOidcConfigForTest } = await loadAuth({ OIDC_ISSUER_URL: `http://127.0.0.1:${port}/realms/r`, OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_TRUST_DISCOVERED_ISSUER: 'true' });
  const cfg = await getOidcConfigForTest();
  assert.equal(cfg.serverMetadata().issuer, 'https://kc.example.com/realms/r');
  kc.close();
});
