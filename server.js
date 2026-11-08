const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || 'ChangeMe123';
const SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL مش متحدد. حط رابط الداتا بيز (Neon) في المتغيرات.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }
});
const q = (text, params) => pool.query(text, params).then(r => r.rows);
const q1 = (text, params) => q(text, params).then(r => r[0]);

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function init() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS chapters (
    id SERIAL PRIMARY KEY,
    day TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    chapter_id INT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS choices (
    id SERIAL PRIMARY KEY,
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS answers (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    choice_id INT NOT NULL REFERENCES choices(id) ON DELETE CASCADE,
    is_correct BOOLEAN NOT NULL,
    answered_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, question_id)
  );`);
  if (!(await q1("SELECT 1 AS x FROM users WHERE role='admin'"))) {
    await q("INSERT INTO users (username, full_name, password_hash, role) VALUES ($1,'Admin',$2,'admin')",
      [ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 10)]);
    console.log(`Admin created -> username: ${ADMIN_USER}`);
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 30 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'سجل دخول الأول' });
const adminOnly = (req, res, next) =>
  req.session.user && req.session.user.role === 'admin' ? next() : res.status(403).json({ error: 'للأدمن فقط' });

// ---------- Auth ----------
app.post('/api/register', h(async (req, res) => {
  const { username, password, full_name } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  const n = String(full_name || '').trim();
  if (!/^[a-z0-9_.]{3,30}$/.test(u)) return res.status(400).json({ error: 'اليوزر: حروف إنجليزي وأرقام (3-30)' });
  if (!n) return res.status(400).json({ error: 'اكتب اسمك' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'الباسورد 6 حروف على الأقل' });
  try {
    const row = await q1('INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [u, n, bcrypt.hashSync(password, 10)]);
    req.session.user = { id: row.id, username: u, full_name: n, role: 'user' };
    res.json(req.session.user);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'اليوزر ده مستخدم' });
    throw e;
  }
}));

app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body || {};
  const row = await q1('SELECT * FROM users WHERE username=$1', [String(username || '').trim().toLowerCase()]);
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash))
    return res.status(401).json({ error: 'اليوزر أو الباسورد غلط' });
  req.session.user = { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
  res.json(req.session.user);
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json(req.session.user || null));

// ---------- Members ----------
app.get('/api/days', auth, h(async (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const sql = `
    SELECT c.id, c.day, c.title,
      (SELECT COUNT(*) FROM questions x WHERE x.chapter_id=c.id)::int AS total,
      (SELECT COUNT(*) FROM answers a JOIN questions x ON x.id=a.question_id
         WHERE x.chapter_id=c.id AND a.user_id=$1)::int AS answered,
      (SELECT COUNT(*) FROM answers a JOIN questions x ON x.id=a.question_id
         WHERE x.chapter_id=c.id AND a.user_id=$1 AND a.is_correct)::int AS correct
    FROM chapters c ${isAdmin ? '' : 'WHERE c.day <= $2'} ORDER BY c.day DESC, c.id DESC`;
  res.json(await q(sql, isAdmin ? [req.session.user.id] : [req.session.user.id, today()]));
}));

app.get('/api/chapters/:id', auth, h(async (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const ch = await q1('SELECT * FROM chapters WHERE id=$1', [req.params.id]);
  if (!ch || (!isAdmin && ch.day > today())) return res.status(404).json({ error: 'مش موجود' });
  const qs = await q('SELECT * FROM questions WHERE chapter_id=$1 ORDER BY id', [ch.id]);
  const mine = await q('SELECT question_id, choice_id FROM answers WHERE user_id=$1', [req.session.user.id]);
  const myMap = Object.fromEntries(mine.map(a => [a.question_id, a.choice_id]));
  const allChoices = qs.length
    ? await q('SELECT id, question_id, text, is_correct FROM choices WHERE question_id = ANY($1) ORDER BY id', [qs.map(x => x.id)])
    : [];
  ch.questions = qs.map(x => {
    const answered = myMap[x.id] != null;
    return {
      id: x.id, text: x.text, my_choice_id: answered ? myMap[x.id] : null,
      choices: allChoices.filter(c => c.question_id === x.id).map(c => ({
        id: c.id, text: c.text, ...(isAdmin || answered ? { is_correct: c.is_correct } : {})
      }))
    };
  });
  res.json(ch);
}));

app.post('/api/answer', auth, h(async (req, res) => {
  const { question_id, choice_id } = req.body || {};
  const qq = await q1('SELECT x.id, c.day FROM questions x JOIN chapters c ON c.id=x.chapter_id WHERE x.id=$1', [question_id]);
  if (!qq || (req.session.user.role !== 'admin' && qq.day > today())) return res.status(404).json({ error: 'السؤال مش موجود' });
  const ch = await q1('SELECT * FROM choices WHERE id=$1 AND question_id=$2', [choice_id, question_id]);
  if (!ch) return res.status(400).json({ error: 'اختيار غلط' });
  try {
    await q('INSERT INTO answers (user_id, question_id, choice_id, is_correct) VALUES ($1,$2,$3,$4)',
      [req.session.user.id, question_id, choice_id, ch.is_correct]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'جاوبت على السؤال ده قبل كده' });
    throw e;
  }
  const right = (await q('SELECT id FROM choices WHERE question_id=$1 AND is_correct', [question_id])).map(r => r.id);
  res.json({ is_correct: ch.is_correct, correct_choice_ids: right });
}));

// ---------- Admin ----------
app.post('/api/admin/chapters', adminOnly, h(async (req, res) => {
  const { day, title, content } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !String(title || '').trim()) return res.status(400).json({ error: 'التاريخ والعنوان مطلوبين' });
  const row = await q1('INSERT INTO chapters (day, title, content) VALUES ($1,$2,$3) RETURNING id', [day, title.trim(), content || '']);
  res.json({ id: row.id });
}));

app.put('/api/admin/chapters/:id', adminOnly, h(async (req, res) => {
  const { day, title, content } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !String(title || '').trim()) return res.status(400).json({ error: 'التاريخ والعنوان مطلوبين' });
  await q('UPDATE chapters SET day=$1, title=$2, content=$3 WHERE id=$4', [day, title.trim(), content || '', req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/admin/chapters/:id', adminOnly, h(async (req, res) => {
  await q('DELETE FROM chapters WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/admin/questions', adminOnly, h(async (req, res) => {
  const { chapter_id, text, choices } = req.body || {};
  const list = (choices || []).filter(c => String(c.text || '').trim());
  if (!String(text || '').trim() || list.length < 2) return res.status(400).json({ error: 'السؤال واختيارين على الأقل' });
  if (!list.some(c => c.is_correct)) return res.status(400).json({ error: 'حدد الإجابة الصح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO questions (chapter_id, text) VALUES ($1,$2) RETURNING id', [chapter_id, text.trim()]);
    for (const c of list)
      await client.query('INSERT INTO choices (question_id, text, is_correct) VALUES ($1,$2,$3)', [rows[0].id, c.text.trim(), !!c.is_correct]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));

app.delete('/api/admin/questions/:id', adminOnly, h(async (req, res) => {
  await q('DELETE FROM questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

async function buildReport() {
  const chapters = await q(`SELECT c.id, c.day, c.title,
    (SELECT COUNT(*) FROM questions WHERE chapter_id=c.id)::int AS total FROM chapters c ORDER BY c.day, c.id`);
  const totalQ = chapters.reduce((s, c) => s + c.total, 0);
  const users = await q("SELECT id, full_name, username FROM users WHERE role='user'");
  const per = await q(`SELECT a.user_id, x.chapter_id, COUNT(*)::int AS answered, SUM(a.is_correct::int)::int AS correct
    FROM answers a JOIN questions x ON x.id=a.question_id GROUP BY a.user_id, x.chapter_id`);
  const rows = users.map(u => {
    const mine = per.filter(p => p.user_id === u.id);
    const answered = mine.reduce((s, p) => s + p.answered, 0);
    const correct = mine.reduce((s, p) => s + p.correct, 0);
    return { ...u, answered, correct, percent: totalQ ? Math.round(correct * 100 / totalQ) : 0,
      by: Object.fromEntries(mine.map(p => [p.chapter_id, p])) };
  }).sort((a, b) => b.correct - a.correct);
  return { chapters, totalQ, rows };
}

app.get('/api/admin/report', adminOnly, h(async (req, res) => res.json(await buildReport())));

app.get('/api/admin/report.csv', adminOnly, h(async (req, res) => {
  const r = await buildReport();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['الاسم', 'اليوزر', 'جاوب', 'صح', 'إجمالي الأسئلة', 'النسبة %', ...r.chapters.map(c => `${c.day} ${c.title}`)];
  const lines = [head.map(esc).join(',')];
  r.rows.forEach(u => lines.push([u.full_name, u.username, u.answered, u.correct, r.totalQ, u.percent,
    ...r.chapters.map(c => `${u.by[c.id]?.correct || 0}/${c.total}`)].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
  res.send('\uFEFF' + lines.join('\n'));
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.code === '22P02' ? 400 : 500).json({ error: 'حصل خطأ في السيرفر' });
});

init().then(() => app.listen(PORT, () => console.log(`Running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
