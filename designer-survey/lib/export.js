'use strict';
const ExcelJS = require('exceljs');
const { formatAnswer } = require('./survey');

function fmtTime(iso) {
  // 统一按北京时间显示
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function fmtDuration(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

function buildTable(survey, rows) {
  const header = ['提交ID', '提交时间（北京时间）', '称呼', '填写用时', '用时（秒）',
    ...survey.questions.map((q) => `${q.no}. ${q.title}`)];
  const data = rows.map((r) => [
    r.id, fmtTime(r.createdAt), r.name, fmtDuration(r.durationSec), r.durationSec == null ? '' : r.durationSec,
    ...survey.questions.map((q) => formatAnswer(q, r.answers, r.other)),
  ]);
  return { header, data };
}

// 防 CSV 公式注入
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(survey, rows) {
  const { header, data } = buildTable(survey, rows);
  const lines = [header, ...data].map((r) => r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

async function toXLSX(survey, rows) {
  const { header, data } = buildTable(survey, rows);
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('提交明细', { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });
  ws.addRow(header);
  data.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ws.columns.forEach((col, i) => { col.width = i < 5 ? [18, 20, 12, 12, 10][i] : 24; });
  ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'top', wrapText: true }; });

  // 第二个工作表：选择题统计
  const st = wb.addWorksheet('选项统计');
  st.addRow(['题目', '选项', '选择人数', '占比（选择人数 / 该题答题人数）']).font = { bold: true };
  for (const s of computeStats(survey, rows)) {
    st.addRow([`${s.no}. ${s.title}（${s.typeLabel}，${s.answered} 人作答）`]).font = { bold: true };
    for (const o of s.options) st.addRow(['', o.label, o.count, s.answered ? o.count / s.answered : 0]);
  }
  st.getColumn(1).width = 46; st.getColumn(2).width = 36; st.getColumn(3).width = 10; st.getColumn(4).width = 18;
  st.getColumn(4).numFmt = '0.0%';
  return wb.xlsx.writeBuffer();
}

function computeStats(survey, rows) {
  const out = [];
  for (const q of survey.questions) {
    if (q.type !== 'single' && q.type !== 'multi') continue;
    const counts = new Map(q.options.map((o) => [o.label, 0]));
    const others = [];
    let answered = 0;
    for (const r of rows) {
      const v = r.answers[q.id];
      if (v == null) continue;
      const list = Array.isArray(v) ? v : [v];
      if (!list.length) continue;
      answered += 1;
      for (const l of list) counts.set(l, (counts.get(l) || 0) + 1);
      if (r.other && r.other[q.id]) others.push({ id: r.id, name: r.name, text: r.other[q.id] });
    }
    out.push({
      id: q.id, no: q.no, title: q.title, type: q.type,
      typeLabel: q.type === 'single' ? '单选' : q.maxSelect ? `多选，最多 ${q.maxSelect} 项` : '多选',
      answered,
      options: [...counts.entries()].map(([label, count]) => ({ label, count })),
      others,
    });
  }
  return out;
}

module.exports = { toCSV, toXLSX, computeStats, fmtTime };
