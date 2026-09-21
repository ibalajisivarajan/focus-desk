// Focus Desk — hosted backend.
// Node.js + Express + libSQL. Storage is pluggable:
//   - Local SQLite file (default, great for local dev), or
//   - Turso cloud database (set TURSO_URL + TURSO_TOKEN) — free tier, no
//     credit card, data persists independently of the web host.
// Same SQL either way: Turso speaks the SQLite dialect.
//
// Auth: email + password (scrypt-hashed) or Google OAuth, session cookie.
// Every /api/* route except /api/auth/* requires a session, and all data is
// scoped to the signed-in user. The first account created adopts any pre-auth
// data. Signup sends an "account created" email; forgot-password emails a
// temporary password. Both go out over SMTP when configured (Gmail SMTP with
// a free app password — no credit card, no domain verification).

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import nodemailer from 'nodemailer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'focusdesk.db');
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';

const useRemote = TURSO_URL.startsWith('libsql://') || TURSO_URL.startsWith('https://');

const SESSION_COOKIE = 'fd_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/* Google OAuth ("Continue with Google"). Optional: only enabled when both
   env vars are set. No API key costs — a free Google Cloud OAuth client. */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleEnabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const OAUTH_STATE_COOKIE = 'fd_oauth_state';

/* Outgoing email (verification + password reset). Optional: only enabled
   when SMTP credentials are set. Uses Gmail's SMTP with an app password —
   free, no credit card, no domain verification needed.
   EMAIL_LOG_FILE (dev only): write emails to this file instead of sending. */
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_APP_PASSWORD = process.env.SMTP_APP_PASSWORD || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const EMAIL_LOG_FILE = process.env.EMAIL_LOG_FILE || '';
const emailEnabled = Boolean((SMTP_USER && SMTP_APP_PASSWORD) || EMAIL_LOG_FILE);

/* ---------------- database ---------------- */
let client;
if (useRemote) {
  client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
} else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  client = createClient({ url: 'file:' + DB_PATH });
}

async function initDb() {
  if (!useRemote) {
    await client.execute('PRAGMA journal_mode = WAL;');
    await client.execute('PRAGMA foreign_keys = ON;');
  }
  await client.batch([
    `CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS habit_marks (
      habit_id TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY (habit_id, day),
      FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      text TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS focus_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      day TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      pass_salt TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_notes (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done, done_at)',
    'CREATE INDEX IF NOT EXISTS idx_marks_day ON habit_marks(day)',
    'CREATE INDEX IF NOT EXISTS idx_focus_day ON focus_sessions(day)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
  ].map((sql) => ({ sql, args: [] })));

  // Per-user scoping for the pre-auth tables (idempotent — safe to re-run).
  for (const t of ['todos', 'habits', 'focus_sessions']) {
    try {
      await client.execute({ sql: `ALTER TABLE ${t} ADD COLUMN user_id TEXT`, args: [] });
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
  await client.execute('CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_focus_user ON focus_sessions(user_id)');

  // Google OAuth account linking (idempotent — safe to re-run).
  for (const col of ['google_sub TEXT', 'email TEXT']) {
    try {
      await client.execute({ sql: `ALTER TABLE users ADD COLUMN ${col}`, args: [] });
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)');

  // Email auth: verification flag + single-use verification tokens.
  // must_change_password marks accounts signed in with an emailed temporary
  // password, so the UI can prompt a real password change (idempotent).
  for (const col of ['email_verified INTEGER NOT NULL DEFAULT 0', 'must_change_password INTEGER NOT NULL DEFAULT 0']) {
    try {
      await client.execute({ sql: `ALTER TABLE users ADD COLUMN ${col}`, args: [] });
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
  // SQLite unique indexes allow multiple NULLs, so legacy username-only
  // accounts are unaffected.
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  await client.batch([
    `CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_verifications_expires ON email_verifications(expires_at)',
  ].map((sql) => ({ sql, args: [] })));

  await client.execute({ sql: 'INSERT OR IGNORE INTO notes (id, text, updated_at) VALUES (1, ?, ?)', args: ['', Date.now()] });
}

// Small wrappers so call sites stay readable.
async function get(sql, ...args) {
  const r = await client.execute({ sql, args });
  return r.rows[0];
}
async function all(sql, ...args) {
  const r = await client.execute({ sql, args });
  return r.rows;
}
async function run(sql, ...args) {
  return client.execute({ sql, args });
}

/* ---------------- helpers ---------------- */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = new Set(['focus', 'short', 'long']);

function todayStr(d = new Date()) {
  const m = d.getMonth() + 1, day = d.getDate();
  return `${d.getFullYear()}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function uid() {
  return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function validId(v) { return typeof v === 'string' && ID_RE.test(v); }
function validDay(v) { return typeof v === 'string' && DAY_RE.test(v); }
function bodyOf(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }
// Express 4 doesn't catch async handler rejections — wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------- auth ---------------- */
const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = await scryptAsync(password, salt, 64);
  return { salt, hash: dk.toString('hex') };
}
async function verifyPassword(password, salt, hash) {
  try {
    const dk = await scryptAsync(password, salt, 64);
    return crypto.timingSafeEqual(dk, Buffer.from(String(hash), 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* skip malformed */ }
  }
  return out;
}

function isSecureReq(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'https') return true;
  if (proto === 'http') return false;
  const host = String(req.headers.host || '');
  return !(host.startsWith('localhost') || host.startsWith('127.0.0.1'));
}

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    token, userId, now, now + SESSION_TTL_MS);
  // Opportunistic cleanup of expired sessions; never blocks login.
  run('DELETE FROM sessions WHERE expires_at < ?', now).catch(() => {});
  const secure = isSecureReq(req) ? '; Secure' : '';
  // append (not set) so OAuth callback can clear its state cookie alongside.
  res.append('Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function sessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = await get('SELECT user_id, expires_at FROM sessions WHERE token = ?', token);
  if (!s) return null;
  if (Number(s.expires_at) < Date.now()) {
    await run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return get('SELECT id, name, email, email_verified, must_change_password FROM users WHERE id = ?', s.user_id);
}

async function authRequired(req, res, next) {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  req.user = user;
  next();
}

function validName(v) {
  return typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 40;
}
function validPassword(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 128;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validEmail(v) {
  return typeof v === 'string' && v.trim().length <= 254 && EMAIL_RE.test(v.trim());
}
function normalizeEmail(v) {
  return v.trim().toLowerCase();
}
// Single-use email tokens: the raw token goes in the link, only its
// sha256 hash is stored, so a database read alone can't redeem them.
function newEmailToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}
function appBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol;
  return `${proto}://${req.headers.host}`;
}

/* ---------------- outgoing email ---------------- */
let mailTransport = null;
function getMailTransport() {
  if (mailTransport || !SMTP_USER || !SMTP_APP_PASSWORD) return mailTransport;
  mailTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD },
  });
  return mailTransport;
}
// Returns true when the email was handed off (sent or logged), false when
// email isn't configured or delivery failed. Never throws.
async function sendMail(to, subject, text) {
  try {
    if (SMTP_USER && SMTP_APP_PASSWORD) {
      await getMailTransport().sendMail({ from: SMTP_FROM, to, subject, text });
      return true;
    }
    if (EMAIL_LOG_FILE) {
      fs.appendFileSync(EMAIL_LOG_FILE,
        `--- ${new Date().toISOString()}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n\n`);
      return true;
    }
  } catch (e) {
    console.error('sendMail failed:', e && e.message);
  }
  return false;
}
function verificationEmailBody(name, link) {
  return `Hi ${name},\n\nYour Focus Desk account was created. Welcome!\n\nPlease verify your email address by opening this link:\n\n${link}\n\nThis link expires in 24 hours. If you didn't create this account, you can ignore this email.\n`;
}
// Temporary-password email for the forgot-password flow: readable, 10
// characters, no lookalike glyphs (0/O, 1/l).
function newTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
function tempPasswordEmailBody(name, tempPassword) {
  return `Hi ${name},\n\nYou asked for a temporary password for your Focus Desk account. Here it is:\n\n    ${tempPassword}\n\nSign in with this temporary password, then open your Profile and set a new password (you can also change your display name there).\n\nIf you didn't request this, you can safely ignore this email — but someone may have your address, so consider picking a fresh password once you're signed in.\n`;
}
// Extra throttle on email-triggering endpoints: max 3 sends per email/hour,
// so one address can't be spammed through us. Best-effort in-memory.
const emailSendLog = new Map(); // key -> array of timestamps
function emailThrottleOk(key) {
  const now = Date.now();
  const arr = (emailSendLog.get(key) || []).filter((t) => now - t < 3600 * 1000);
  if (arr.length >= 3) return false;
  arr.push(now);
  emailSendLog.set(key, arr);
  return true;
}

// The very first account (username or Google) adopts any data created
// before auth existed.
async function adoptLegacyData(userId) {
  for (const t of ['todos', 'habits', 'focus_sessions']) {
    await run(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`, userId);
  }
  const old = await get('SELECT text, updated_at FROM notes WHERE id = 1');
  if (old && old.text) {
    await run('INSERT OR IGNORE INTO user_notes (user_id, text, updated_at) VALUES (?,?,?)',
      userId, old.text, old.updated_at);
  }
}

/* ---------------- google oauth ---------------- */
function googleRedirectUri(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol;
  return `${proto}://${req.headers.host}/api/auth/google/callback`;
}

let googleCertsCache = null; // { keys, fetchedAt }
// fetch with a timeout so a hung upstream can't hang the callback request.
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}
async function googleCerts() {
  const now = Date.now();
  if (googleCertsCache && now - googleCertsCache.fetchedAt < 60 * 60 * 1000) return googleCertsCache.keys;
  const r = await fetchWithTimeout('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('cert fetch failed');
  const j = await r.json();
  googleCertsCache = { keys: j.keys || [], fetchedAt: now };
  return googleCertsCache.keys;
}
function b64urlToBuffer(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
// Verifies the ID token's RS256 signature against Google's published keys
// and checks audience / issuer / expiry. Throws on anything suspicious.
async function verifyGoogleIdToken(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('bad token shape');
  const header = JSON.parse(b64urlToBuffer(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlToBuffer(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  const jwk = (await googleCerts()).find((k) => k && k.kid === header.kid);
  if (!jwk) throw new Error('unknown key id');
  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const sigOk = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, b64urlToBuffer(parts[2]));
  if (!sigOk) throw new Error('bad signature');
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('bad audience');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('bad issuer');
  }
  if (!payload.exp || payload.exp * 1000 < Date.now() - 30000) throw new Error('expired');
  if (!payload.sub) throw new Error('no subject');
  return payload;
}

/* ---------------- per-user queries ---------------- */
async function getStats(userId, day) {
  const tasksDone = (await get('SELECT COUNT(*) AS c FROM todos WHERE user_id = ? AND done = 1 AND done_at = ?', userId, day)).c;
  const habitsChecked = (await get(
    `SELECT COUNT(DISTINCT m.habit_id) AS c FROM habit_marks m
     JOIN habits h ON h.id = m.habit_id WHERE h.user_id = ? AND m.day = ?`, userId, day)).c;
  const habitsTotal = (await get('SELECT COUNT(*) AS c FROM habits WHERE user_id = ?', userId)).c;
  const f = await get('SELECT COALESCE(SUM(minutes),0) AS minutes, COUNT(*) AS sessions FROM focus_sessions WHERE user_id = ? AND day = ?', userId, day);
  return { tasksDone, habitsChecked, habitsTotal, focusMinutes: f.minutes, focusSessions: f.sessions };
}

async function streakOf(userId, habitId) {
  const has = async (day) => (await get(
    `SELECT 1 AS one FROM habit_marks m JOIN habits h ON h.id = m.habit_id
     WHERE h.user_id = ? AND m.habit_id = ? AND m.day = ?`, userId, habitId, day)) !== undefined;
  let streak = 0;
  const d = new Date();
  if (!(await has(todayStr(d)))) d.setDate(d.getDate() - 1);
  while (await has(todayStr(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

async function todoRow(userId, id) {
  return get('SELECT id, text, done, done_at AS doneAt FROM todos WHERE user_id = ? AND id = ?', userId, id);
}

async function habitRow(userId, id) {
  const h = await get('SELECT id, name FROM habits WHERE user_id = ? AND id = ?', userId, id);
  if (!h) return null;
  const marks = {};
  for (const m of await all("SELECT day FROM habit_marks WHERE habit_id = ? AND day >= date('now','-13 days')", id)) {
    marks[m.day] = 1;
  }
  return { id: h.id, name: h.name, marks, streak: await streakOf(userId, id) };
}

/* ---------------- app ---------------- */
const app = express();

// Behind Render (or any proxy) so rate limiting sees the real client IP.
app.set('trust proxy', 1);

// Security headers. CSP allows the app's own inline <style>/<script>
// (single-file frontend) plus the keyless Open-Meteo weather APIs.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://api.open-meteo.com", "https://geocoding-api.open-meteo.com"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' }));

// Rate-limit the API only (health checks and static files stay unrestricted).
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many requests, slow down' },
}));

// Stricter limit for auth endpoints (brute-force protection).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many sign-in attempts, try again later' },
});

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---- auth (public) ---- */
app.post('/api/auth/signup', authLimiter, ah(async (req, res) => {
  const b = bodyOf(req);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? normalizeEmail(b.email) : '';
  if (!validName(name)) return res.status(400).json({ error: 'name must be 1-40 characters' });
  if (!validEmail(b.email)) return res.status(400).json({ error: 'enter a valid email address' });
  if (!validPassword(b.password)) return res.status(400).json({ error: 'password must be 8-128 characters' });
  if (await get('SELECT id FROM users WHERE lower(name) = lower(?)', name)) {
    return res.status(409).json({ error: 'that name is taken' });
  }
  if (await get('SELECT id FROM users WHERE email = ?', email)) {
    return res.status(409).json({ error: 'that email is already registered' });
  }
  const { salt, hash } = await hashPassword(b.password);
  const id = uid();
  const now = Date.now();
  await run('INSERT INTO users (id, name, email, email_verified, pass_salt, pass_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    id, name, email, 0, salt, hash, now);
  // The very first account adopts any data created before auth existed.
  if (Number((await get('SELECT COUNT(*) AS c FROM users')).c) === 1) {
    await adoptLegacyData(id);
  }
  // Verification email is best-effort: signup succeeds even if mail isn't
  // configured or delivery fails.
  if (emailEnabled && emailThrottleOk('verify:' + email)) {
    const { token, tokenHash } = newEmailToken();
    await run('INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES (?,?,?)',
      tokenHash, id, now + 24 * 3600 * 1000);
    const link = `${appBaseUrl(req)}/api/auth/verify-email?token=${token}`;
    sendMail(email, 'Your Focus Desk account was created', verificationEmailBody(name, link));
  }
  await createSession(req, res, id);
  res.status(201).json({ ok: true, user: { id, name, email, email_verified: 0, must_change_password: 0 } });
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  const b = bodyOf(req);
  // New clients send {identifier}; the old field name is still accepted.
  const identifier = typeof b.identifier === 'string' ? b.identifier.trim()
    : (typeof b.name === 'string' ? b.name.trim() : '');
  const idLower = identifier.toLowerCase();
  const u = identifier ? await get(
    'SELECT id, name, email, email_verified, must_change_password, pass_salt, pass_hash FROM users WHERE lower(email) = ? OR lower(name) = ?',
    idLower, idLower) : null;
  // Google-created accounts have no password — they can only sign in via Google
  // (until the owner sets one through the forgot-password or change-password flow).
  if (!u || !u.pass_hash || !(await verifyPassword(b.password || '', u.pass_salt, u.pass_hash))) {
    return res.status(401).json({ error: 'invalid email/username or password' });
  }
  await createSession(req, res, u.id);
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email, email_verified: u.email_verified, must_change_password: u.must_change_password } });
}));

app.post('/api/auth/logout', ah(async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await run('DELETE FROM sessions WHERE token = ?', token);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// Forgot password: email a temporary password and flag the account so the
// UI prompts a real password change in Profile. Always responds the same way
// so the endpoint can't be used to enumerate accounts.
app.post('/api/auth/forgot-password', authLimiter, ah(async (req, res) => {
  const b = bodyOf(req);
  const email = typeof b.email === 'string' ? normalizeEmail(b.email) : '';
  if (emailEnabled && validEmail(b.email) && emailThrottleOk('temppass:' + email)) {
    const u = await get('SELECT id, name, email FROM users WHERE email = ?', email);
    if (u && u.email) {
      const temp = newTempPassword();
      const { salt, hash } = await hashPassword(temp);
      await run('UPDATE users SET pass_salt = ?, pass_hash = ?, must_change_password = 1 WHERE id = ?',
        salt, hash, u.id);
      sendMail(u.email, 'Your temporary Focus Desk password', tempPasswordEmailBody(u.name, temp));
    }
  }
  res.json({ ok: true, message: 'If an account exists for that email, a temporary password is on its way.' });
}));

// Change password from Profile (signed in): needs the current password
// (unless the account has none, e.g. Google-only so far) and clears the
// must_change_password flag.
app.post('/api/auth/change-password', authLimiter, ah(async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const b = bodyOf(req);
  if (!validPassword(b.newPassword)) return res.status(400).json({ error: 'new password must be 8-128 characters' });
  const full = await get('SELECT id, pass_salt, pass_hash FROM users WHERE id = ?', user.id);
  if (full && full.pass_hash) {
    if (!(await verifyPassword(b.currentPassword || '', full.pass_salt, full.pass_hash))) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }
  }
  const { salt, hash } = await hashPassword(b.newPassword);
  await run('UPDATE users SET pass_salt = ?, pass_hash = ?, must_change_password = 0 WHERE id = ?',
    salt, hash, user.id);
  res.json({ ok: true });
}));

// Update the signed-in user's display name.
app.patch('/api/auth/profile', authLimiter, ah(async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const b = bodyOf(req);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!validName(name)) return res.status(400).json({ error: 'name must be 1-40 characters' });
  if (await get('SELECT id FROM users WHERE lower(name) = lower(?) AND id <> ?', name, user.id)) {
    return res.status(409).json({ error: 'that name is taken' });
  }
  await run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
  const updated = await sessionUser(req);
  res.json({ ok: true, user: updated });
}));

// Email verification link (24h, single-use). Login never blocks on it.
app.get('/api/auth/verify-email', authLimiter, ah(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  let ok = false;
  if (/^[a-f0-9]{64}$/.test(token)) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await get('SELECT user_id, expires_at FROM email_verifications WHERE token_hash = ?', tokenHash);
    if (row && Number(row.expires_at) >= Date.now()) {
      await run('UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
      ok = true;
    }
    if (row) await run('DELETE FROM email_verifications WHERE token_hash = ?', tokenHash);
  }
  res.redirect('/?' + (ok ? 'verified=1' : 'verified=0'));
}));

// Re-send the verification email to the signed-in user.
app.post('/api/auth/resend-verification', authLimiter, ah(async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const full = await get('SELECT id, name, email, email_verified FROM users WHERE id = ?', user.id);
  if (emailEnabled && full && full.email && !full.email_verified && emailThrottleOk('verify:' + full.email)) {
    const { token, tokenHash } = newEmailToken();
    await run('DELETE FROM email_verifications WHERE user_id = ?', full.id);
    await run('INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES (?,?,?)',
      tokenHash, full.id, Date.now() + 24 * 3600 * 1000);
    const link = `${appBaseUrl(req)}/api/auth/verify-email?token=${token}`;
    sendMail(full.email, 'Verify your Focus Desk email', verificationEmailBody(full.name, link));
  }
  res.json({ ok: true });
}));

app.get('/api/auth/me', ah(async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  res.json({ user });
}));

// Which sign-in methods the server offers (lets the UI hide Google and the
// forgot-password link when unconfigured).
app.get('/api/auth/providers', (req, res) => {
  res.json({ google: googleEnabled, email: emailEnabled });
});

// Step 1: redirect the browser to Google's consent screen.
app.get('/api/auth/google', authLimiter, ah(async (req, res) => {
  if (!googleEnabled) return res.status(503).json({ error: 'google sign-in is not configured' });
  const state = crypto.randomBytes(16).toString('hex');
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.append('Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
}));

// Step 2: Google redirects back here with an authorization code.
app.get('/api/auth/google/callback', authLimiter, ah(async (req, res) => {
  // The state cookie is single-use: clear it on every exit path.
  res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  const fail = (reason) => res.redirect('/?auth_error=' + encodeURIComponent(reason));
  if (!googleEnabled) return fail('not_configured');
  const cookies = parseCookies(req);
  if (!cookies[OAUTH_STATE_COOKIE] || !req.query.state || req.query.state !== cookies[OAUTH_STATE_COOKIE]) {
    return fail('bad_state');
  }
  if (req.query.error) return fail('denied');
  if (!req.query.code) return fail('no_code');

  let payload;
  try {
    const tr = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tj = await tr.json();
    if (!tr.ok || !tj.id_token) throw new Error('token exchange failed');
    payload = await verifyGoogleIdToken(tj.id_token);
  } catch (e) {
    console.error('google oauth failed:', e.message);
    return fail('exchange_failed');
  }

  const sub = String(payload.sub);
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const emailVerifiedByGoogle = payload.email_verified === true;
  let user = await get('SELECT id, name FROM users WHERE google_sub = ?', sub);
  if (!user && email && emailVerifiedByGoogle) {
    // This Google account owns a verified email that's already registered:
    // link it instead of creating a duplicate account.
    const existing = await get('SELECT id, name FROM users WHERE email = ?', email);
    if (existing) {
      await run('UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ?', sub, existing.id);
      user = existing;
    }
  }
  if (!user) {
    // First Google sign-in: create an account (name from profile, deduped).
    const base = (typeof payload.name === 'string' && payload.name.trim()) || email.split('@')[0] || 'user';
    let gname = base.slice(0, 40);
    for (let n = 1; await get('SELECT id FROM users WHERE lower(name) = lower(?)', gname); n++) {
      gname = (base.slice(0, 36) + ' ' + n).slice(0, 40);
    }
    const id = uid();
    const now = Date.now();
    await run('INSERT INTO users (id, name, pass_salt, pass_hash, google_sub, email, email_verified, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, gname, '', '', sub, email, emailVerifiedByGoogle ? 1 : 0, now);
    if (Number((await get('SELECT COUNT(*) AS c FROM users')).c) === 1) {
      await adoptLegacyData(id);
    }
    user = { id, name: gname };
  }
  await createSession(req, res, user.id);
  res.redirect('/');
}));

// Everything below requires a signed-in user.
app.use('/api/', ah(authRequired));

/* ---- combined state (what the frontend boots from) ---- */
app.get('/api/state', ah(async (req, res) => {
  const u = req.user.id;
  const day = todayStr();
  const todos = await all('SELECT id, text, done, done_at AS doneAt FROM todos WHERE user_id = ? ORDER BY position DESC, created_at DESC', u);
  const habitIds = await all('SELECT id FROM habits WHERE user_id = ? ORDER BY created_at ASC, rowid ASC', u);
  const habits = [];
  for (const h of habitIds) habits.push(await habitRow(u, h.id));
  const notes = await get('SELECT text FROM user_notes WHERE user_id = ?', u);
  res.json({ todos, habits, notes: notes ? notes.text : '', stats: await getStats(u, day), user: req.user });
}));

/* ---- todos ---- */
app.post('/api/todos', ah(async (req, res) => {
  const u = req.user.id;
  const b = bodyOf(req);
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > 200) return res.status(400).json({ error: 'text must be 1-200 characters' });
  let id = b.id;
  if (id !== undefined && !validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!id) id = uid();
  const m = (await get('SELECT COALESCE(MAX(position),0) AS m FROM todos WHERE user_id = ?', u)).m || 0;
  await run('INSERT INTO todos (id, user_id, text, done, done_at, position, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    id, u, text, 0, null, m + 1, Date.now());
  res.status(201).json(await todoRow(u, id));
}));

app.patch('/api/todos/:id', ah(async (req, res) => {
  const u = req.user.id;
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!(await get('SELECT id FROM todos WHERE user_id = ? AND id = ?', u, id))) return res.status(404).json({ error: 'not found' });
  const b = bodyOf(req);
  const sets = [], vals = [];
  if (typeof b.text === 'string') {
    const t = b.text.trim();
    if (!t || t.length > 200) return res.status(400).json({ error: 'text must be 1-200 characters' });
    sets.push('text = ?'); vals.push(t);
  }
  if (typeof b.done === 'boolean') {
    sets.push('done = ?', 'done_at = ?');
    vals.push(b.done ? 1 : 0, b.done ? todayStr() : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  await run(`UPDATE todos SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, ...vals, u, id);
  res.json(await todoRow(u, id));
}));

app.delete('/api/todos/:id', ah(async (req, res) => {
  const u = req.user.id;
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  const r = await run('DELETE FROM todos WHERE user_id = ? AND id = ?', u, id);
  if (Number(r.rowsAffected) === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

/* ---- habits ---- */
app.post('/api/habits', ah(async (req, res) => {
  const u = req.user.id;
  const b = bodyOf(req);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'name must be 1-80 characters' });
  let id = b.id;
  if (id !== undefined && !validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!id) id = uid();
  await run('INSERT INTO habits (id, user_id, name, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
    id, u, name, Date.now());
  res.status(201).json(await habitRow(u, id));
}));

app.delete('/api/habits/:id', ah(async (req, res) => {
  const u = req.user.id;
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!(await get('SELECT id FROM habits WHERE user_id = ? AND id = ?', u, id))) {
    return res.status(404).json({ error: 'not found' });
  }
  const tx = await client.transaction('write');
  try {
    await tx.execute({ sql: 'DELETE FROM habit_marks WHERE habit_id = ?', args: [id] });
    await tx.execute({ sql: 'DELETE FROM habits WHERE user_id = ? AND id = ?', args: [u, id] });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  res.json({ ok: true });
}));

app.post('/api/habits/:id/checkin', ah(async (req, res) => {
  const u = req.user.id;
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!(await get('SELECT id FROM habits WHERE user_id = ? AND id = ?', u, id))) return res.status(404).json({ error: 'not found' });
  const b = bodyOf(req);
  let day = b.day;
  if (day === undefined || day === null) day = todayStr();
  if (!validDay(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  const exists = await get('SELECT 1 AS one FROM habit_marks WHERE habit_id = ? AND day = ?', id, day);
  let done;
  if (exists) {
    await run('DELETE FROM habit_marks WHERE habit_id = ? AND day = ?', id, day);
    done = false;
  } else {
    await run('INSERT INTO habit_marks (habit_id, day) VALUES (?,?)', id, day);
    done = true;
  }
  res.json({ ok: true, id, day, done, streak: await streakOf(u, id), stats: await getStats(u, todayStr()) });
}));

/* ---- notes ---- */
app.get('/api/notes', ah(async (req, res) => {
  const u = req.user.id;
  const n = await get('SELECT text, updated_at AS updatedAt FROM user_notes WHERE user_id = ?', u);
  res.json({ text: n ? n.text : '', updatedAt: n ? n.updatedAt : null });
}));

app.put('/api/notes', ah(async (req, res) => {
  const u = req.user.id;
  const b = bodyOf(req);
  const text = typeof b.text === 'string' ? b.text : null;
  if (text === null || text.length > 200000) return res.status(400).json({ error: 'text must be a string up to 200000 characters' });
  const now = Date.now();
  await run(`INSERT INTO user_notes (user_id, text, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    u, text, now);
  res.json({ ok: true, updatedAt: now });
}));

/* ---- focus sessions ---- */
app.post('/api/focus/sessions', ah(async (req, res) => {
  const u = req.user.id;
  const b = bodyOf(req);
  if (!MODES.has(b.mode)) return res.status(400).json({ error: 'mode must be focus, short, or long' });
  if (!Number.isInteger(b.minutes) || b.minutes < 0 || b.minutes > 480) {
    return res.status(400).json({ error: 'minutes must be an integer 0-480' });
  }
  const day = todayStr();
  const r = await run('INSERT INTO focus_sessions (user_id, mode, minutes, day, created_at) VALUES (?,?,?,?,?)',
    u, b.mode, b.minutes, day, Date.now());
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), stats: await getStats(u, day) });
}));

app.get('/api/focus/stats', ah(async (req, res) => {
  const u = req.user.id;
  let day = req.query.day;
  if (day === undefined) day = todayStr();
  if (!validDay(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  res.json({ day, ...(await getStats(u, day)) });
}));

/* ---- frontend + errors ---- */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

await initDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Focus Desk listening on :${PORT}`);
  console.log(useRemote ? `Database: Turso (${TURSO_URL})` : `Database: local file ${DB_PATH}`);
});
