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
    // Issuer aus den Discovery-Daten übernehmen, auch wenn er von OIDC_ISSUER_URL abweicht
    // (z. B. Keycloak hinter Proxy meldet http:// oder einen anderen Hostnamen).
    trustDiscoveredIssuer: env.OIDC_TRUST_DISCOVERED_ISSUER === 'true',
    // Diese E-Mail-Adressen (kommagetrennt) sind immer Admin. Rollen werden sonst in der App vergeben.
    adminEmails: (env.ADMIN_EMAILS ?? (authMode === 'dev' ? 'dev@localhost' : ''))
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  },
};
