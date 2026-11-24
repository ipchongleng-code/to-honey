'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { getSurvey, validateSubmission, formatAnswer } = require('./lib/survey');
const db = require('./lib/db');
const { toCSV, toXLSX, computeStats } = require('./lib/export');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'designer-survey';
const COOKIE = 'ds_admin';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

// ---------- 小工具 ----------
function sessionToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('admin:' + ADMIN_PASSWORD).digest('hex');
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAdmin(req) {
  return !!ADMIN_PASSWORD && safeEqual(readCookie(req, COOKIE), sessionToken());
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
// 简单的内存限流：key 在 windowMs 内最多 max 次
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'too_many_requests' });
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    next();
  };
}
function newId() {
  // 形如 20261124-8F3A2C：日期 + 6 位随机，便于口头核对
  const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  return d + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ---------- 问卷 API ----------
app.get('/api/survey', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getSurvey());
});

app.post('/api/submit', limiter(20, 60 * 60 * 1000), (req, res) => {
  const survey = getSurvey();
  const body = req.body || {};
  const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : '';

  // 同一设备重复提交：直接返回之前那份，防止重复入库
  if (clientId) {
    const existing = db.findByClientId(clientId);
    if (existing) return res.json({ ok: true, id: existing.id, duplicate: true });
  }

  const { ok, errors, clean } = validateSubmission(survey, body);
  if (!ok) return res.status(400).json({ ok: false, error: 'invalid', fields: errors });

  let durationSec = Math.round(Number(body.durationSec));
  if (!Number.isFinite(durationSec) || durationSec < 0) durationSec = null;
  else durationSec = Math.min(durationSec, 7 * 24 * 3600);

  const rec = {
    id: newId(),
    createdAt: new Date().toISOString(),
    surveyId: survey.id,
    clientId: clientId || null,
    name: clean.name,
    answers: clean.answers,
    other: clean.other,
    durationSec,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    ip: req.ip,
  };
  try {
    db.insertSubmission(rec);
  } catch (e) {
    if (clientId && String(e.message).includes('UNIQUE')) {
      const existing = db.findByClientId(clientId);
      if (existing) return res.json({ ok: true, id: existing.id, duplicate: true });
    }
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
  res.json({ ok: true, id: rec.id });
});

// ---------- 后台 API ----------
app.post('/api/admin/login', limiter(10, 10 * 60 * 1000), (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'no_password_configured' });
  const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!safeEqual(pw, ADMIN_PASSWORD)) return res.status(401).json({ error: 'wrong_password' });
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req), configured: !!ADMIN_PASSWORD }));

app.get('/api/admin/data', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const survey = getSurvey();
  const rows = db.listSubmissions();
  res.json({
    survey,
    submissions: rows.map((r) => ({
      id: r.id, createdAt: r.createdAt, name: r.name, durationSec: r.durationSec, userAgent: r.userAgent,
      answers: r.answers, other: r.other,
      display: Object.fromEntries(survey.questions.map((q) => [q.id, formatAnswer(q, r.answers, r.other)])),
    })),
    stats: computeStats(survey, rows),
  });
});

app.delete('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  res.json({ ok: db.deleteSubmission(req.params.id) });
});

function stamp() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}
function attachment(res, filename) {
  res.set('Content-Disposition', `attachment; filename="survey-${stamp()}.${filename}"; filename*=UTF-8''${encodeURIComponent('设计师调研-' + stamp() + '.' + filename)}`);
}

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  attachment(res, 'csv');
  res.type('text/csv; charset=utf-8').send(toCSV(getSurvey(), db.listSubmissions().reverse()));
});

app.get('/api/admin/export.xlsx', requireAdmin, async (req, res, next) => {
  try {
    const buf = await toXLSX(getSurvey(), db.listSubmissions().reverse());
    attachment(res, 'xlsx');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// ---------- 页面 ----------
const pub = path.join(__dirname, 'public');
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use(express.static(pub, {
  setHeaders(res, file) {
    // HTML 不缓存（微信会强缓存），静态资源靠 ?v= 版本号刷新
    if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.type || 'server_error' });
});

app.listen(PORT, () => {
  console.log(`问卷已启动： http://localhost:${PORT}`);
  console.log(`管理后台：   http://localhost:${PORT}/admin`);
  console.log(`数据文件：   ${db.DB_FILE}`);
  if (!ADMIN_PASSWORD) console.warn('⚠️  未设置 ADMIN_PASSWORD，后台将无法登录（见 .env.example）');
});
