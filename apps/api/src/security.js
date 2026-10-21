import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = 'referralos_session';
const CSRF_COOKIE = 'referralos_csrf';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, cost, saltText, keyText] = encoded.split('$');
  if (algorithm !== 'scrypt' || cost !== '16384' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = Buffer.from(await scryptAsync(password, Buffer.from(saltText, 'base64url'), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
function parseCookies(header = '') {
  const values = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try { values[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* malformed cookie is ignored */ }
  }
  return values;
}
function cookieOptions(config, maxAge) {
  return `Path=/; SameSite=Lax; Max-Age=${maxAge}${config.nodeEnv === 'production' ? '; Secure' : ''}`;
}

export function createCsrfToken(res, config) {
  const token = randomBytes(32).toString('base64url');
  res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(config, 86400)}`);
  return token;
}

export function csrfGuard(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    const allowedOrigins = config.allowedOrigins ?? [config.appOrigin];
    if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Request origin was not accepted.' });
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[CSRF_COOKIE] ?? '';
    const headerToken = req.get('x-csrf-token') ?? '';
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(403).json({ error: 'Refresh the page and try again.' });
    next();
  };
}

export function createSession(db, userId, config, res) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(token), userId, expiresAt);
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${cookieOptions(config, config.sessionDays * 86400)}`);
}

export function clearSessionCookie(res, config) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; ${cookieOptions(config, 0)}`);
}

export function loadUser(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 256) return null;
  const row = db.prepare(`SELECT u.id,u.email,p.display_name,p.headline,p.location,p.bio,p.skills_json,p.resume_name,p.resume_consent,
      s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN profiles p ON p.user_id=u.id
    WHERE s.id_hash=? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL`).get(hashToken(token));
  if (!row) return null;
  // Record authenticated activity at most once per minute to keep online estimates useful
  // without turning every API request into a SQLite write.
  db.prepare(`UPDATE sessions SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id_hash=? AND last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')`).run(hashToken(token));
  const roles = db.prepare('SELECT role FROM user_roles WHERE user_id=? ORDER BY role').all(row.id).map((item) => item.role);
  return { id: row.id, email: row.email, displayName: row.display_name, headline: row.headline, location: row.location, bio: row.bio, skills: JSON.parse(row.skills_json), resumeName: row.resume_name, resumeConsent: Boolean(row.resume_consent), roles };
}

export function attachUser(db) {
  return (req, _res, next) => {
    req.user = loadUser(db, req);
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!req.user.roles.includes(role)) return res.status(403).json({ error: 'You do not have access to this area.' });
    next();
  };
}

export function requireAdmin(allowedEmails = []) {
  const allowlist = new Set(allowedEmails.map((email) => email.trim().toLowerCase()));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!req.user.roles.includes('admin') || !allowlist.has(req.user.email.toLowerCase())) {
      return res.status(403).json({ error: 'You do not have access to this area.' });
    }
    next();
  };
}
