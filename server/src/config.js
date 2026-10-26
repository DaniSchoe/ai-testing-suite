// Zentrale Konfiguration aus Umgebungsvariablen (in Kubernetes über ConfigMap/Secret).
const env = process.env;

function required(name, fallback) {
  const value = env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Umgebungsvariable ${name} fehlt`);
  return value;
}

const authMode = env.AUTH_MODE ?? 'oidc'; // 'oidc' oder 'dev' (lokal ohne Keycloak)

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL', 'postgres://suite:suite@localhost:5432/suite'),
  // Wird für Session-Cookies und zur Verschlüsselung von API-Keys/Passwörtern genutzt.
  appSecret: required('APP_SECRET', authMode === 'dev' ? 'dev-secret-dev-secret-dev-secret-32' : undefined),
  runWorker: (env.RUN_WORKER ?? 'true') === 'true',
  workerConcurrency: Number(env.WORKER_CONCURRENCY ?? 2),
  logLevel: env.LOG_LEVEL ?? 'info',
  auth: {
    mode: authMode,
    issuer: env.OIDC_ISSUER_URL, // z. B. https://keycloak.example.com/realms/ai-testing
    clientId: env.OIDC_CLIENT_ID ?? 'ai-testing-suite',
    clientSecret: env.OIDC_CLIENT_SECRET,
    // Client für Test-Personas (Direct Access Grants), getrennt vom Login-Client.
    personaClientId: env.OIDC_PERSONA_CLIENT_ID ?? 'ai-testing-personas',
    personaClientSecret: env.OIDC_PERSONA_CLIENT_SECRET,
    allowInsecure: env.OIDC_ALLOW_INSECURE === 'true', // nur für lokales http-Keycloak
    // Rollen aus Keycloak: realm_access.roles und resource_access[clientId].roles
    roleMap: {
      admin: env.ROLE_ADMIN ?? 'suite-admin',
      tester: env.ROLE_TESTER ?? 'suite-tester',
      viewer: env.ROLE_VIEWER ?? 'suite-viewer',
    },
    // Ohne passende Rolle bekommt ein User diese Rolle (leer = kein Zugriff).
    defaultRole: env.DEFAULT_ROLE ?? 'viewer',
  },
};
