// Focus Desk — hosted backend.
// Node.js + Express + libSQL. Storage is pluggable:
//   - Local SQLite file (default, great for local dev), or
//   - Turso cloud database (set TURSO_URL + TURSO_TOKEN) — free tier, no
//     credit card, data persists independently of the web host.
// Same SQL either way: Turso speaks the SQLite dialect.

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@libsql/client';
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
    'CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done, done_at)',
    'CREATE INDEX IF NOT EXISTS idx_marks_day ON habit_marks(day)',
    'CREATE INDEX IF NOT EXISTS idx_focus_day ON focus_sessions(day)',
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

async function getStats(day) {
  const tasksDone = (await get('SELECT COUNT(*) AS c FROM todos WHERE done = 1 AND done_at = ?', day)).c;
  const habitsChecked = (await get('SELECT COUNT(DISTINCT habit_id) AS c FROM habit_marks WHERE day = ?', day)).c;
  const habitsTotal = (await get('SELECT COUNT(*) AS c FROM habits')).c;
  const f = await get('SELECT COALESCE(SUM(minutes),0) AS minutes, COUNT(*) AS sessions FROM focus_sessions WHERE day = ?', day);
  return { tasksDone, habitsChecked, habitsTotal, focusMinutes: f.minutes, focusSessions: f.sessions };
}

async function streakOf(habitId) {
  const has = async (day) => (await get('SELECT 1 AS one FROM habit_marks WHERE habit_id = ? AND day = ?', habitId, day)) !== undefined;
  let streak = 0;
  const d = new Date();
  if (!(await has(todayStr(d)))) d.setDate(d.getDate() - 1);
  while (await has(todayStr(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

async function todoRow(id) {
  return get('SELECT id, text, done, done_at AS doneAt FROM todos WHERE id = ?', id);
}

async function habitRow(id) {
  const h = await get('SELECT id, name FROM habits WHERE id = ?', id);
  if (!h) return null;
  const marks = {};
  for (const m of await all("SELECT day FROM habit_marks WHERE habit_id = ? AND day >= date('now','-13 days')", id)) {
    marks[m.day] = 1;
  }
  return { id: h.id, name: h.name, marks, streak: await streakOf(id) };
}

/* ---------------- app ---------------- */
const app = express();

// Security headers. CSP allows the app's own inline <style>/<script>
// (single-file frontend), nothing else.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
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

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---- combined state (what the frontend boots from) ---- */
app.get('/api/state', ah(async (req, res) => {
  const day = todayStr();
  const todos = await all('SELECT id, text, done, done_at AS doneAt FROM todos ORDER BY position DESC, created_at DESC');
  const habitIds = await all('SELECT id FROM habits ORDER BY created_at ASC, rowid ASC');
  const habits = [];
  for (const h of habitIds) habits.push(await habitRow(h.id));
  const notes = await get('SELECT text FROM notes WHERE id = 1');
  res.json({ todos, habits, notes: notes ? notes.text : '', stats: await getStats(day) });
}));

/* ---- todos ---- */
app.post('/api/todos', ah(async (req, res) => {
  const b = bodyOf(req);
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > 200) return res.status(400).json({ error: 'text must be 1-200 characters' });
  let id = b.id;
  if (id !== undefined && !validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!id) id = uid();
  const m = (await get('SELECT COALESCE(MAX(position),0) AS m FROM todos')).m || 0;
  await run('INSERT INTO todos (id, text, done, done_at, position, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    id, text, 0, null, m + 1, Date.now());
  res.status(201).json(await todoRow(id));
}));

app.patch('/api/todos/:id', ah(async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!(await get('SELECT id FROM todos WHERE id = ?', id))) return res.status(404).json({ error: 'not found' });
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
  await run(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  res.json(await todoRow(id));
}));

app.delete('/api/todos/:id', ah(async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  const r = await run('DELETE FROM todos WHERE id = ?', id);
  if (Number(r.rowsAffected) === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

/* ---- habits ---- */
app.post('/api/habits', ah(async (req, res) => {
  const b = bodyOf(req);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'name must be 1-80 characters' });
  let id = b.id;
  if (id !== undefined && !validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!id) id = uid();
  await run('INSERT INTO habits (id, name, created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',
    id, name, Date.now());
  res.status(201).json(await habitRow(id));
}));

app.delete('/api/habits/:id', ah(async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  const tx = await client.transaction('write');
  let changes = 0;
  try {
    await tx.execute({ sql: 'DELETE FROM habit_marks WHERE habit_id = ?', args: [id] });
    const r = await tx.execute({ sql: 'DELETE FROM habits WHERE id = ?', args: [id] });
    changes = Number(r.rowsAffected);
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  if (changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

app.post('/api/habits/:id/checkin', ah(async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'invalid id' });
  if (!(await get('SELECT id FROM habits WHERE id = ?', id))) return res.status(404).json({ error: 'not found' });
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
  res.json({ ok: true, id, day, done, streak: await streakOf(id), stats: await getStats(todayStr()) });
}));

/* ---- notes ---- */
app.get('/api/notes', ah(async (req, res) => {
  const n = await get('SELECT text, updated_at AS updatedAt FROM notes WHERE id = 1');
  res.json({ text: n ? n.text : '', updatedAt: n ? n.updatedAt : null });
}));

app.put('/api/notes', ah(async (req, res) => {
  const b = bodyOf(req);
  const text = typeof b.text === 'string' ? b.text : null;
  if (text === null || text.length > 200000) return res.status(400).json({ error: 'text must be a string up to 200000 characters' });
  const now = Date.now();
  await run(`INSERT INTO notes (id, text, updated_at) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    text, now);
  res.json({ ok: true, updatedAt: now });
}));

/* ---- focus sessions ---- */
app.post('/api/focus/sessions', ah(async (req, res) => {
  const b = bodyOf(req);
  if (!MODES.has(b.mode)) return res.status(400).json({ error: 'mode must be focus, short, or long' });
  if (!Number.isInteger(b.minutes) || b.minutes < 0 || b.minutes > 480) {
    return res.status(400).json({ error: 'minutes must be an integer 0-480' });
  }
  const day = todayStr();
  const r = await run('INSERT INTO focus_sessions (mode, minutes, day, created_at) VALUES (?,?,?,?)',
    b.mode, b.minutes, day, Date.now());
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), stats: await getStats(day) });
}));

app.get('/api/focus/stats', ah(async (req, res) => {
  let day = req.query.day;
  if (day === undefined) day = todayStr();
  if (!validDay(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  res.json({ day, ...(await getStats(day)) });
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
