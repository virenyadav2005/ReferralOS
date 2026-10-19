import path from 'node:path';

const DEFAULT_APP_ORIGINS = ['http://127.0.0.1:5173'];
const DEFAULT_PERSONAL_DOMAINS = ['gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','outlook.com','hotmail.com','live.com','msn.com','icloud.com','me.com','aol.com','proton.me','protonmail.com','gmx.com','mail.com','yandex.com'];

function readAllowedOrigins(env) {
  const configured = env.APP_ORIGINS ?? env.APP_ORIGIN;
  const origins = configured === undefined
    ? DEFAULT_APP_ORIGINS
    : configured.split(',').map((value) => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('APP_ORIGINS must contain at least one allowed frontend origin.');
  return [...new Set(origins.map((value) => {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`Invalid frontend origin in APP_ORIGINS: ${value}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
      throw new Error(`Frontend origins must be exact http(s) origins without paths: ${value}`);
    }
    return parsed.origin;
  }))];
}

export function readConfig(env = process.env) {
  const allowedOrigins = readAllowedOrigins(env);
  let companyDomainMappings = {};
  try { companyDomainMappings = JSON.parse(env.COMPANY_DOMAIN_MAPPINGS ?? '{}'); }
  catch { throw new Error('COMPANY_DOMAIN_MAPPINGS must be a JSON object mapping company names to domain arrays.'); }
  if (!companyDomainMappings || Array.isArray(companyDomainMappings) || typeof companyDomainMappings !== 'object' ||
      Object.values(companyDomainMappings).some((domains) => !Array.isArray(domains) || domains.some((domain) => typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain)))) {
    throw new Error('COMPANY_DOMAIN_MAPPINGS must be a JSON object mapping company names to domain arrays.');
  }
  const personalEmailDomains = (env.PERSONAL_EMAIL_DOMAINS ?? DEFAULT_PERSONAL_DOMAINS.join(','))
    .split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    demoMode: (env.DEMO_MODE ?? '').trim().toLowerCase() === 'true',
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    appOrigin: allowedOrigins[0],
    allowedOrigins,
    personalEmailDomains: [...new Set(personalEmailDomains)],
    companyDomainMappings: Object.fromEntries(Object.entries(companyDomainMappings).map(([company, domains]) => [company.trim().toLowerCase(), domains.map((domain) => domain.toLowerCase())])),
    databasePath: path.resolve(process.cwd(), env.DATABASE_PATH ?? './data/referralos.sqlite'),
    resumeStoragePath: path.resolve(process.cwd(), env.RESUME_STORAGE_DIR ?? './data/private-resumes'),
    jobImportStoragePath: path.resolve(process.cwd(), env.JOB_IMPORT_STORAGE_DIR ?? './data/private-job-imports'),
    screenshotOcrUrl: env.SCREENSHOT_OCR_URL ?? '',
    screenshotOcrApiKey: env.SCREENSHOT_OCR_API_KEY ?? '',
    sessionDays: Math.min(30, Math.max(1, Number(env.SESSION_DAYS ?? 7))),
    emailProvider: env.EMAIL_PROVIDER ?? (env.NODE_ENV === 'production' ? 'unconfigured' : 'console'),
    resendApiKey: env.RESEND_API_KEY ?? '',
    emailFrom: env.EMAIL_FROM ?? '',
    emailVerificationMinutes: Math.min(1440, Math.max(5, Number(env.EMAIL_VERIFICATION_MINUTES ?? 30))),
    publicAppUrl: env.PUBLIC_APP_URL ?? allowedOrigins[0],
  };
}
