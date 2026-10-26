// Login über Keycloak (OIDC Authorization Code + PKCE) und Berechtigungsprüfung.
// Keycloak liefert nur die Identität; Rollen, Berechtigungen und Teams pflegt die Anwendung.
import * as oidc from 'openid-client';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { config } from './config.js';
import { createHash } from 'node:crypto';
import { many, one, query } from './db.js';
import { effectivePermissions, hasPermission, isEnvAdmin } from './permissions.js';

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

// Issuer vergleichen ohne Unterschied bei abschließendem Slash.
const normalizeIssuer = (url) => String(url).replace(/\/+$/, '');

// Discovery über die .well-known-URL. Die Bibliothek vergleicht bei der Issuer-URL strikt (inkl. Slash und
// Schema) und meldet nur "issuer does not match". Hier prüfen wir selbst und nennen beide Werte.
async function discover(clientId, clientAuthentication) {
  const issuer = normalizeIssuer(config.auth.issuer ?? '');
  if (!issuer) throw new Error('OIDC_ISSUER_URL ist nicht gesetzt');
  const options = config.auth.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined;
  const cfg = await oidc.discovery(new URL(`${issuer}/.well-known/openid-configuration`), clientId, undefined, clientAuthentication, options);
  const discovered = normalizeIssuer(cfg.serverMetadata().issuer);
  if (discovered !== issuer) {
    const hint =
      `OIDC_ISSUER_URL ist "${issuer}", Keycloak meldet aber den Issuer "${discovered}". ` +
      'Meist liegt das an Keycloak-Hostname/Proxy-Einstellungen (KC_HOSTNAME, KC_PROXY_HEADERS) oder an http statt https. ' +
      'Den gemeldeten Wert als OIDC_ISSUER_URL setzen oder OIDC_TRUST_DISCOVERED_ISSUER=true.';
    if (!config.auth.trustDiscoveredIssuer) throw new Error(hint);
    console.warn(`OIDC: ${hint} Verwende den gemeldeten Issuer.`);
  }
  return cfg;
}

let oidcConfig;
async function getOidcConfig() {
  oidcConfig ??= await discover(config.auth.clientId, oidc.ClientSecretPost(config.auth.clientSecret));
  return oidcConfig;
}
export const getOidcConfigForTest = getOidcConfig;

// Login übernehmen: bekannter User (sub), vorab angelegter User (bestätigte E-Mail) oder neuer User.
export async function upsertUser({ sub, username, email, emailVerified, displayName }) {
  const known = await one(
    `update users set username = $2, email = $3, email_verified = $4, display_name = $5, last_login_at = now()
     where sub = $1 returning id`,
    [sub, username, email ?? null, Boolean(emailVerified), displayName ?? null],
  );
  if (known) return known;
  if (email && emailVerified) {
    const pending = await one(
      `update users set sub = $1, username = $2, email = $3, email_verified = true, display_name = coalesce(display_name, $4),
         last_login_at = now()
       where sub is null and lower(email) = lower($3) returning id`,
      [sub, username, email, displayName ?? null],
    );
    if (pending) return pending;
  }
  const created = await one(
    `insert into users (sub, username, email, email_verified, display_name, last_login_at)
     values ($1, $2, $3, $4, $5, now()) returning id`,
    [sub, username, email ?? null, Boolean(emailVerified), displayName ?? null],
  );
  // Neue User erhalten die Standardrolle im Standard-Mandanten; weitere Mandanten vergibt ein Administrator.
  await query(
    `insert into user_roles (user_id, role_id, tenant_id)
     select $1, r.id, t.id from roles r cross join tenants t where r.is_default and t.key = 'default'
     on conflict do nothing`,
    [created.id],
  );
  return created;
}

// User samt Rollen und Teams im gewählten Mandanten und den effektiven Berechtigungen laden.
// Ohne (oder mit unzulässigem) Mandanten gilt der erste, auf den der User Zugriff hat.
export async function loadUser(id, wantedTenantId = null) {
  const row = await one('select * from users where id = $1', [id]);
  if (!row) return null;
  const envAdmin = isEnvAdmin(row, config.auth.adminEmails);
  const grants = await many(
    `select ur.tenant_id, r.id as role_id, r.key, r.name, r.permissions
     from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`,
    [id],
  );
  const globalAdmin = grants.some((g) => g.key === 'admin' && !g.tenant_id);
  const systemAdmin = envAdmin || globalAdmin;
  // Globale Nicht-Admin-Rollen (ohne Mandant) gelten in jedem Mandanten.
  const everywhere = grants.some((g) => !g.tenant_id);
  const allTenants = await many('select id, key, name from tenants order by name');
  const tenants =
    systemAdmin || everywhere ? allTenants : allTenants.filter((t) => grants.some((g) => g.tenant_id === t.id));
  const tenant = tenants.find((t) => t.id === wantedTenantId) ?? tenants.find((t) => t.key === 'default') ?? tenants[0] ?? null;
  const own = grants.filter((g) => tenant && (g.tenant_id === tenant.id || !g.tenant_id));
  const teams = tenant
    ? await many(
        `select t.id, t.name from team_members tm join teams t on t.id = tm.team_id
         where tm.user_id = $1 and t.tenant_id = $2 order by t.name`,
        [id, tenant.id],
      )
    : [];
  const rolePermissions = [...new Set(own.flatMap((g) => g.permissions))];
  const tenantAdmin = own.some((g) => g.key === 'admin' && g.tenant_id === tenant?.id);
  const disabled = row.disabled && !envAdmin;
  return {
    ...row,
    roles: own.map((g) => ({ id: g.role_id, key: g.key, name: g.name })),
    teams,
    tenant,
    tenant_id: tenant?.id ?? null,
    tenants,
    env_admin: envAdmin,
    is_system_admin: systemAdmin,
    // Administrator im aktuellen Mandanten: System-Administrator oder Admin-Rolle des Mandanten.
    is_admin: systemAdmin || tenantAdmin,
    // Admins per Umgebungsvariable lassen sich nicht aussperren.
    disabled,
    permissions: disabled || !tenant ? [] : effectivePermissions({ rolePermissions, hasAdminRole: globalAdmin, tenantAdmin, envAdmin }),
  };
}

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export { hasPermission };

// preHandler-Factory: requirePermission('tests.manage') etc.
export function requirePermission(permission) {
  return async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Nicht angemeldet' });
    if (request.user.disabled) return reply.code(403).send({ error: 'Konto gesperrt' });
    if (!hasPermission(request.user, permission)) {
      return reply.code(403).send({ error: `Berechtigung "${permission}" erforderlich` });
    }
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
    // Service-Token (CI/CD, CLI): Authorization: Bearer sat_…
    const bearer = /^Bearer (sat_[\w-]+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (bearer) {
      const token = await one(
        `update service_tokens set last_used_at = now()
         where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now()) returning user_id, tenant_id`,
        [tokenHash(bearer)],
      );
      if (token) request.user = await loadUser(token.user_id, token.tenant_id);
      return;
    }
    const userId = request.session.get('userId');
    if (userId) request.user = await loadUser(userId, request.headers['x-tenant-id'] || request.session.get('tenantId') || null);
  });

  app.get('/auth/login', async (request, reply) => {
    if (config.auth.mode === 'dev') {
      // Lokal ohne Keycloak: dev-admin (in ADMIN_EMAILS) oder ?as=<name> für weitere Test-User.
      const name = /^[a-z0-9-]{1,32}$/.test(request.query.as ?? '') ? request.query.as : 'dev-admin';
      const user = await upsertUser({
        sub: name === 'dev-admin' ? name : `dev-${name}`,
        username: name,
        email: name === 'dev-admin' ? 'dev@localhost' : `${name}@localhost`,
        emailVerified: true,
        displayName: name === 'dev-admin' ? 'Dev Admin' : name,
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
    const claims = tokens.claims();
    const user = await upsertUser({
      sub: claims.sub,
      username: claims.preferred_username ?? claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true,
      displayName: claims.name ?? claims.preferred_username,
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

// Nicht kapseln: Session, request.user und Hook sollen für alle Routen gelten.
authPlugin[Symbol.for('skip-override')] = true;
