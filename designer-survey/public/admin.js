(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var data = null;
  var currentId = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, url, body) {
    return fetch(url, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
    });
  }
  function fmtTime(iso) {
    try {
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  function fmtTimeFull(iso) {
    try {
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso)) + '（北京时间）';
    } catch (e) { return iso; }
  }
  function fmtDur(sec) {
    if (sec == null) return '—';
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
  }
  function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 + '%' : '0%'; }

  // ---------- 登录 ----------
  function showLogin(note) {
    $('main').hidden = true; $('login').hidden = false;
    if (note) $('loginNote').textContent = note;
    setTimeout(function () { $('pw').focus(); }, 30);
  }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('loginErr').hidden = true;
    api('POST', 'api/admin/login', { password: $('pw').value }).then(function (r) {
      if (r.ok) { $('pw').value = ''; loadData(); return; }
      $('loginErr').textContent = r._status === 429 ? '尝试次数过多，请 10 分钟后再试'
        : r.error === 'no_password_configured' ? '服务器未设置 ADMIN_PASSWORD 环境变量' : '密码错误';
      $('loginErr').hidden = false;
    });
  });
  $('logout').addEventListener('click', function () { api('POST', 'api/admin/logout').then(function () { showLogin('已退出'); }); });
  $('refresh').addEventListener('click', loadData);

  function loadData() {
    api('GET', 'api/admin/data').then(function (r) {
      if (r._status === 401) return api('GET', 'api/admin/me').then(function (m) {
        showLogin(m.configured ? '请输入后台密码' : '服务器未设置 ADMIN_PASSWORD 环境变量，请先配置后重启');
      });
      data = r;
      $('login').hidden = true; $('main').hidden = false;
      render();
    });
  }

  // ---------- 渲染 ----------
  function render() {
    var subs = data.submissions;
    $('surveyTitle').textContent = data.survey.title + ' · 后台';
    document.title = '问卷后台 · ' + subs.length + ' 份';
    var durs = subs.map(function (s) { return s.durationSec; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    var median = durs.length ? durs[Math.floor((durs.length - 1) / 2)] : null;
    $('summary').textContent = '共 ' + subs.length + ' 份提交' + (subs.length ? ' · 最近一份 ' + fmtTime(subs[0].createdAt) : '') + (median != null ? ' · 用时中位数 ' + fmtDur(median) : '');
    renderStats(); renderList();
  }

  function sectionOf(qid) {
    var secs = data.survey.sections;
    for (var i = 0; i < secs.length; i++) for (var j = 0; j < secs[i].questions.length; j++) if (secs[i].questions[j].id === qid) return secs[i];
    return null;
  }

  function renderStats() {
    var el = $('tab-stats');
    if (!data.submissions.length) { el.innerHTML = '<div class="empty">还没有提交。把问卷链接发出去吧。</div>'; return; }
    var h = '<p class="note">占比 = 选择该项的人数 ÷ 该题作答人数。多选题各项占比之和会超过 100%。把鼠标移到条形上可看具体人数。</p>';
    var statsById = {};
    data.stats.forEach(function (s) { statsById[s.id] = s; });
    data.survey.sections.forEach(function (sec) {
      h += '<div class="sec-title">' + esc(sec.id + '. ' + sec.title) + '</div>';
      sec.questions.forEach(function (q) {
        var s = statsById[q.id];
        if (s) h += statCard(s);
        else h += textCard(q);
      });
    });
    el.innerHTML = h;
  }

  function statCard(s) {
    var max = 0;
    s.options.forEach(function (o) { if (o.count > max) max = o.count; });
    var h = '<div class="card"><div class="q-head"><h3>' + s.no + '. ' + esc(s.title) + '</h3><span class="meta">' + esc(s.typeLabel) + ' · ' + s.answered + ' 人作答</span></div><div class="bars">';
    s.options.forEach(function (o) {
      var w = s.answered ? (o.count / s.answered) * 100 : 0;
      var tip = esc(o.label) + '：' + o.count + ' 人，占 ' + pct(o.count, s.answered);
      h += '<div class="bar-label">' + esc(o.label) + '</div>' +
        '<div class="bar-track" data-tip="' + tip + '"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
        '<div class="bar-val"><b>' + o.count + '</b> 人 · ' + pct(o.count, s.answered) + '</div>';
    });
    h += '</div>';
    if (s.others.length) {
      h += '<div class="others"><h4>「其他」填写内容</h4><ul>' + s.others.map(function (o) {
        return '<li>' + esc(o.text) + '<span class="who">' + esc(o.name || o.id) + '</span></li>';
      }).join('') + '</ul></div>';
    }
    return h + '</div>';
  }

  function textCard(q) {
    var items = data.submissions.filter(function (s) { return s.answers[q.id]; });
    var h = '<div class="card"><div class="q-head"><h3>' + q.no + '. ' + esc(q.title) + '</h3><span class="meta">文本 · ' + items.length + ' 人作答</span></div>';
    if (!items.length) h += '<div class="muted">暂无回答</div>';
    else h += '<div class="texts"><ul>' + items.map(function (s) {
      return '<li>' + esc(s.answers[q.id]) + '<span class="who">' + esc(s.name || s.id) + '</span></li>';
    }).join('') + '</ul></div>';
    return h + '</div>';
  }

  function renderList() {
    var el = $('tab-list');
    var subs = data.submissions;
    if (!subs.length) { el.innerHTML = '<div class="empty">还没有提交。</div>'; return; }
    var h = '<div class="table-scroll"><table><thead><tr><th>提交时间</th><th>称呼</th><th>用时</th><th>职位</th><th>公司类型</th><th>提交 ID</th></tr></thead><tbody>';
    subs.forEach(function (s) {
      h += '<tr data-id="' + esc(s.id) + '"><td class="num">' + esc(fmtTime(s.createdAt)) + '</td><td>' + (s.name ? esc(s.name) : '<span class="muted">未填</span>') +
        '</td><td class="num">' + esc(fmtDur(s.durationSec)) + '</td><td>' + esc(s.display.q3 || '') + '</td><td>' + esc(s.display.q2 || '') +
        '</td><td class="mono">' + esc(s.id) + '</td></tr>';
    });
    el.innerHTML = h + '</tbody></table></div><p class="note">点击任意一行查看完整答卷。</p>';
  }

  // ---------- 详情 ----------
  function openDetail(id) {
    var s = null;
    data.submissions.forEach(function (x) { if (x.id === id) s = x; });
    if (!s) return;
    currentId = id;
    $('modalTitle').textContent = s.name || '（未填称呼）';
    $('modalMeta').textContent = fmtTimeFull(s.createdAt) + ' · 用时 ' + fmtDur(s.durationSec) + ' · ID ' + s.id;
    var h = '';
    data.survey.sections.forEach(function (sec) {
      h += '<div class="ans-sec">' + esc(sec.id + '. ' + sec.title) + '</div>';
      sec.questions.forEach(function (q) {
        var a = s.display[q.id];
        h += '<div class="ans"><div class="q">' + q.no + '. ' + esc(q.title) + '</div><div class="a' + (a ? '' : ' none') + '">' + (a ? esc(a) : '未作答') + '</div></div>';
      });
    });
    h += '<div class="ans"><div class="q">设备</div><div class="a small muted">' + esc(s.userAgent) + '</div></div>';
    $('modalBody').innerHTML = h;
    $('modal').hidden = false;
    $('modalBody').scrollTop = 0;
  }
  function closeDetail() { $('modal').hidden = true; currentId = null; }

  $('tab-list').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.getAttribute('data-id'));
  });
  $('modal').addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) closeDetail(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
  $('delBtn').addEventListener('click', function () {
    if (!currentId) return;
    if (!confirm('确定删除这份提交吗？删除后无法恢复。')) return;
    api('DELETE', 'api/admin/submissions/' + encodeURIComponent(currentId)).then(function () { closeDetail(); loadData(); });
  });

  // ---------- 标签页 ----------
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.toggle('on', x === t); });
      $('tab-stats').hidden = t.getAttribute('data-tab') !== 'stats';
      $('tab-list').hidden = t.getAttribute('data-tab') !== 'list';
    });
  });

  // ---------- 条形图悬停提示 ----------
  var tip = $('tip');
  document.addEventListener('mousemove', function (e) {
    var t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });

  loadData();
})();
