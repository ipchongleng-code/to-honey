'use strict';
// 存储层：Node 内置 SQLite（node:sqlite），无需编译原生模块。
// 如需换成云数据库，只需重新实现下面导出的这几个函数。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'survey.sqlite');

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS submissions (
    id            TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL,
    survey_id     TEXT NOT NULL,
    client_id     TEXT UNIQUE,
    name          TEXT,
    answers       TEXT NOT NULL,
    other         TEXT NOT NULL,
    duration_sec  INTEGER,
    user_agent    TEXT,
    ip            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at);
`);

const stmts = {
  insert: db.prepare(`INSERT INTO submissions (id, created_at, survey_id, client_id, name, answers, other, duration_sec, user_agent, ip)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  byClient: db.prepare('SELECT * FROM submissions WHERE client_id = ?'),
  byId: db.prepare('SELECT * FROM submissions WHERE id = ?'),
  all: db.prepare('SELECT * FROM submissions ORDER BY created_at DESC'),
  del: db.prepare('DELETE FROM submissions WHERE id = ?'),
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    surveyId: row.survey_id,
    name: row.name || '',
    answers: JSON.parse(row.answers),
    other: JSON.parse(row.other),
    durationSec: row.duration_sec,
    userAgent: row.user_agent || '',
    ip: row.ip || '',
  };
}

function insertSubmission(s) {
  stmts.insert.run(s.id, s.createdAt, s.surveyId, s.clientId || null, s.name || '',
    JSON.stringify(s.answers), JSON.stringify(s.other), s.durationSec, s.userAgent || '', s.ip || '');
}

module.exports = {
  DB_FILE,
  insertSubmission,
  findByClientId: (cid) => hydrate(stmts.byClient.get(cid)),
  getSubmission: (id) => hydrate(stmts.byId.get(id)),
  listSubmissions: () => stmts.all.all().map(hydrate),
  deleteSubmission: (id) => stmts.del.run(id).changes > 0,
};
