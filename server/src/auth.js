// Login über Keycloak (OIDC Authorization Code + PKCE) und Rollenprüfung.
import * as oidc from 'openid-client';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { config } from './config.js';
import { one, query } from './db.js';

const ROLE_RANK = { viewer: 1, tester: 2, admin: 3 };

// Session-Store in Postgres, damit mehrere Web-Pods sich Sessions teilen.
class PgSessionStore {
  set(sid, session, cb) {
    const expires = session.cookie?.expires ? new Date(session.cookie.expires) : new Date(Date.now() + 8 * 3600e3);
    query(
      `insert into sessions (sid, sess, expires_at) values ($1, $2, $3)
       on conflict (sid) do update set sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(session), expires],
    ).then(() => cb(), cb);
  }
  get(sid, cb) {
    one('select sess from sessions where sid = $1 and expires_at > now()', [sid]).then(
      (row) => cb(null, row?.sess ?? null),
      cb,
    );
  }
  destroy(sid, cb) {
    query('delete from sessions where sid = $1', [sid]).then(() => cb(), cb);
  }
}

let oidcConfig;
async function getOidcConfig() {
  if (!oidcConfig) {
    const options = config.auth.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined;
    oidcConfig = await oidc.discovery(
      new URL(config.auth.issuer),
      config.auth.clientId,
      undefined,
      oidc.ClientSecretPost(config.auth.clientSecret),
      options,
    );
  }
  return oidcConfig;
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// Keycloak-Rollen (Realm- und Client-Rollen) auf Suite-Rollen abbilden.
export function mapRoles(claims) {
  const kcRoles = new Set([
    ...(claims.realm_access?.roles ?? []),
    ...(claims.resource_access?.[config.auth.clientId]?.roles ?? []),
    ...(Array.isArray(claims.roles) ? claims.roles : []),
  ]);
  const roles = Object.entries(config.auth.roleMap)
    .filter(([, kcRole]) => kcRoles.has(kcRole))
    .map(([role]) => role);
  if (roles.length === 0 && config.auth.defaultRole) roles.push(config.auth.defaultRole);
  return roles;
}

async function upsertUser({ sub, username, email, displayName, roles }) {
  return one(
    `insert into users (sub, username, email, display_name, roles, last_login_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (sub) do update set username = excluded.username, email = excluded.email,
       display_name = excluded.display_name, roles = excluded.roles, last_login_at = now()
     returning *`,
    [sub, username, email, displayName, roles],
  );
}

export function hasRole(user, role) {
  return (user?.roles ?? []).some((r) => (ROLE_RANK[r] ?? 0) >= ROLE_RANK[role]);
}

// preHandler-Factory: requireRole('tester') etc.
export function requireRole(role) {
  return async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Nicht angemeldet' });
    if (!hasRole(request.user, role)) return reply.code(403).send({ error: `Rolle "${role}" erforderlich` });
  };
}

export async function authPlugin(app) {
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: config.appSecret.padEnd(32, '0'),
    cookieName: 'suite_session',
    store: new PgSessionStore(),
    saveUninitialized: false,
    cookie: {
      secure: config.publicUrl.startsWith('https://'),
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 3600e3,
    },
  });

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const userId = request.session.get('userId');
    if (userId) request.user = await one('select * from users where id = $1', [userId]);
  });

  app.get('/auth/login', async (request, reply) => {
    if (config.auth.mode === 'dev') {
      const user = await upsertUser({
        sub: 'dev-admin',
        username: 'dev-admin',
        email: 'dev@localhost',
        displayName: 'Dev Admin',
        roles: ['admin'],
      });
      request.session.set('userId', user.id);
      return reply.redirect('/');
    }
    const cfg = await getOidcConfig();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    request.session.set('oidc', { verifier, state });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: `${config.publicUrl}/auth/callback`,
      scope: 'openid profile email',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
    });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', async (request, reply) => {
    const pending = request.session.get('oidc');
    if (!pending) return reply.redirect('/auth/login');
    const cfg = await getOidcConfig();
    const tokens = await oidc.authorizationCodeGrant(cfg, new URL(request.url, config.publicUrl), {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
    });
    const claims = { ...tokens.claims(), ...decodeJwtPayload(tokens.access_token) };
    const user = await upsertUser({
      sub: claims.sub,
      username: claims.preferred_username ?? claims.sub,
      email: claims.email,
      displayName: claims.name ?? claims.preferred_username,
      roles: mapRoles(claims),
    });
    request.session.set('oidc', undefined);
    request.session.set('userId', user.id);
    request.session.set('idToken', tokens.id_token);
    return reply.redirect('/');
  });

  app.get('/auth/logout', async (request, reply) => {
    const idToken = request.session.get('idToken');
    await request.session.destroy();
    if (config.auth.mode === 'dev' || !idToken) return reply.redirect('/');
    const cfg = await getOidcConfig();
    const url = oidc.buildEndSessionUrl(cfg, { id_token_hint: idToken, post_logout_redirect_uri: config.publicUrl });
    return reply.redirect(url.href);
  });
}

// Token für eine Test-Persona holen (Resource Owner Password Grant gegen den Persona-Client).
// So kann der Runner Requests "als" ein bestimmter Keycloak-User ausführen.
const personaTokenCache = new Map();
export async function getPersonaToken(username, password) {
  const cached = personaTokenCache.get(username);
  if (cached && cached.expiresAt > Date.now() + 30e3) return cached.token;
  const options = config.auth.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined;
  const cfg = await oidc.discovery(
    new URL(config.auth.issuer),
    config.auth.personaClientId,
    undefined,
    config.auth.personaClientSecret ? oidc.ClientSecretPost(config.auth.personaClientSecret) : oidc.None(),
    options,
  );
  const tokens = await oidc.genericGrantRequest(cfg, 'password', { username, password, scope: 'openid' });
  personaTokenCache.set(username, { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 60) * 1000 });
  return tokens.access_token;
}

// Nicht kapseln: Session, request.user und Hook sollen für alle Routen gelten.
authPlugin[Symbol.for('skip-override')] = true;
