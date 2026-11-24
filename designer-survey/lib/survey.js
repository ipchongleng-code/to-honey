'use strict';
// 读取题目配置 + 校验提交 + 把答案格式化成可读文本（导出/后台共用）
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = process.env.QUESTIONS_FILE || path.join(__dirname, '..', 'config', 'questions.json');

let cache = { mtimeMs: 0, survey: null };

function normalizeOption(opt) {
  if (typeof opt === 'string') return { label: opt, input: false, exclusive: false };
  return { label: String(opt.label), input: !!opt.input, exclusive: !!opt.exclusive };
}

function normalize(raw) {
  const survey = {
    id: raw.id || 'survey',
    title: raw.title || '',
    intro: raw.intro || '',
    respondent: Object.assign({ label: '你的称呼或编号', placeholder: '', maxLength: 50 }, raw.respondent || {}),
    thanks: Object.assign({ title: '提交成功，感谢！', text: '' }, raw.thanks || {}),
    sections: [],
  };
  let no = 0;
  const seen = new Set();
  for (const sec of raw.sections || []) {
    const s = { id: String(sec.id || ''), title: sec.title || '', questions: [] };
    for (const q of sec.questions || []) {
      if (!q.id || seen.has(q.id)) throw new Error('题目 id 缺失或重复：' + q.id);
      if (!['single', 'multi', 'text', 'textarea'].includes(q.type)) throw new Error('未知题型：' + q.type + '（' + q.id + '）');
      seen.add(q.id);
      no += 1;
      const nq = {
        id: q.id,
        no,
        title: q.title || '',
        type: q.type,
        required: q.required !== false,
        placeholder: q.placeholder || '',
        maxLength: q.maxLength || (q.type === 'textarea' ? 1000 : 200),
      };
      if (q.type === 'single' || q.type === 'multi') {
        nq.options = (q.options || []).map(normalizeOption);
        if (!nq.options.length) throw new Error('选择题没有选项：' + q.id);
        if (q.type === 'multi' && q.maxSelect) nq.maxSelect = Number(q.maxSelect);
      }
      s.questions.push(nq);
    }
    survey.sections.push(s);
  }
  survey.questions = survey.sections.flatMap((s) => s.questions);
  return survey;
}

function getSurvey() {
  const st = fs.statSync(CONFIG_PATH);
  if (!cache.survey || st.mtimeMs !== cache.mtimeMs) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cache = { mtimeMs: st.mtimeMs, survey: normalize(raw) };
  }
  return cache.survey;
}

const OTHER_MAX = 200;

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

// 返回 { ok, errors:[qid], clean:{ name, answers, other } }
function validateSubmission(survey, body) {
  const errors = [];
  const answersIn = (body && typeof body.answers === 'object' && body.answers) || {};
  const otherIn = (body && typeof body.other === 'object' && body.other) || {};
  const answers = {};
  const other = {};

  for (const q of survey.questions) {
    const v = answersIn[q.id];
    if (q.type === 'text' || q.type === 'textarea') {
      const t = str(v, q.maxLength);
      if (t) answers[q.id] = t;
      else if (q.required) errors.push(q.id);
      continue;
    }
    const labels = q.options.map((o) => o.label);
    if (q.type === 'single') {
      if (typeof v === 'string' && labels.includes(v)) {
        answers[q.id] = v;
      } else if (q.required) { errors.push(q.id); continue; } else continue;
    } else {
      const arr = Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && labels.includes(x)))] : [];
      // 按配置顺序排列
      arr.sort((a, b) => labels.indexOf(a) - labels.indexOf(b));
      const excl = q.options.filter((o) => o.exclusive).map((o) => o.label);
      const badExclusive = arr.length > 1 && arr.some((x) => excl.includes(x));
      const tooMany = q.maxSelect && arr.length > q.maxSelect;
      if (badExclusive || tooMany) { errors.push(q.id); continue; }
      if (!arr.length) { if (q.required) errors.push(q.id); continue; }
      answers[q.id] = arr;
    }
    // 「其他」填写内容
    const chosen = Array.isArray(answers[q.id]) ? answers[q.id] : [answers[q.id]];
    const inputOpt = q.options.find((o) => o.input && chosen.includes(o.label));
    if (inputOpt) {
      const t = str(otherIn[q.id], OTHER_MAX);
      if (t) other[q.id] = t;
    }
  }
  const name = str(body && body.name, survey.respondent.maxLength || 50);
  return { ok: errors.length === 0, errors, clean: { name, answers, other } };
}

// 某题答案的可读文本，如「本地中小装企」「纯设计；半包」「其他（自由职业）」
function formatAnswer(q, answers, other) {
  const v = answers[q.id];
  if (v == null || v === '') return '';
  if (q.type === 'text' || q.type === 'textarea') return String(v);
  const list = Array.isArray(v) ? v : [v];
  return list
    .map((label) => {
      const opt = (q.options || []).find((o) => o.label === label);
      if (opt && opt.input && other && other[q.id]) return label + '（' + other[q.id] + '）';
      return label;
    })
    .join('；');
}

module.exports = { getSurvey, validateSubmission, formatAnswer, CONFIG_PATH };
