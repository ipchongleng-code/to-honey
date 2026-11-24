/* 问卷填写页：从 /api/survey 读取题目配置并渲染。不依赖任何外部资源，兼容微信内置浏览器。 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var survey = null;
  var state = null;
  var storeKey = '';
  var submitting = false;
  var restoredFromStorage = false;

  // ---------- 本地暂存（所有读写包 try/catch，隐私模式等情况下静默降级） ----------
  function load(key) {
    try { var s = window.localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function save() {
    if (!state) return;
    try { window.localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function clearStore() {
    try { window.localStorage.removeItem(storeKey); } catch (e) { /* ignore */ }
  }

  function uuid() {
    if (window.crypto && window.crypto.getRandomValues) {
      var b = new Uint8Array(16); window.crypto.getRandomValues(b);
      return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }
    return Date.now().toString(16) + Math.random().toString(16).slice(2);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2200);
  }

  function qById(id) {
    for (var i = 0; i < survey.questions.length; i++) if (survey.questions[i].id === id) return survey.questions[i];
    return null;
  }

  // ---------- 状态 ----------
  function freshState() {
    return { v: 1, clientId: uuid(), name: '', answers: {}, other: {}, activeMs: 0, startedAt: null, submitted: null };
  }

  // 丢弃配置中已不存在的题目/选项，防止改题后旧暂存出错
  function sanitize(st) {
    var ans = {};
    survey.questions.forEach(function (q) {
      var v = st.answers[q.id];
      if (v == null) return;
      if (q.type === 'text' || q.type === 'textarea') { if (typeof v === 'string') ans[q.id] = v; return; }
      var labels = q.options.map(function (o) { return o.label; });
      if (q.type === 'single') { if (labels.indexOf(v) > -1) ans[q.id] = v; return; }
      if (Array.isArray(v)) {
        var arr = v.filter(function (x) { return labels.indexOf(x) > -1; });
        if (q.maxSelect) arr = arr.slice(0, q.maxSelect);
        if (arr.length) ans[q.id] = arr;
      }
    });
    st.answers = ans;
    st.other = st.other && typeof st.other === 'object' ? st.other : {};
    return st;
  }

  // ---------- 填写用时：只累计页面可见的时间 ----------
  var lastTick = Date.now();
  function tick() {
    var now = Date.now();
    var delta = now - lastTick;
    lastTick = now;
    if (!state || state.submitted || !state.startedAt) return;
    if (document.visibilityState === 'hidden') return;
    state.activeMs += Math.min(delta, 30000); // 防止休眠后一次性跳很多
  }
  setInterval(function () { tick(); save(); }, 5000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { tick(); save(); } else { lastTick = Date.now(); }
  });
  window.addEventListener('pagehide', function () { tick(); save(); });

  function touch() {
    if (!state.startedAt) { state.startedAt = new Date().toISOString(); lastTick = Date.now(); }
  }

  // ---------- 渲染 ----------
  function typeTags(q) {
    var t = [];
    if (q.type === 'single') t.push('<span class="tag">单选</span>');
    if (q.type === 'multi') t.push('<span class="tag">' + (q.maxSelect ? '多选 · 最多 ' + q.maxSelect + ' 项' : '多选') + '</span>');
    if (!q.required) t.push('<span class="tag muted">选填</span>');
    return t.length ? '<div class="q-tags">' + t.join('') + '</div>' : '<div style="height:10px"></div>';
  }

  function renderQuestion(q) {
    var h = '<div class="card q" id="card-' + q.id + '" data-qid="' + q.id + '">';
    h += '<h3 class="q-title"><span class="q-no">' + q.no + '.</span> ' + esc(q.title) + (q.required ? '<span class="q-req" aria-label="必答">*</span>' : '') + '</h3>';
    h += typeTags(q);
    if (q.type === 'single' || q.type === 'multi') {
      var kind = q.type === 'single' ? 'radio' : 'checkbox';
      h += '<div class="opts" role="' + (kind === 'radio' ? 'radiogroup' : 'group') + '">';
      q.options.forEach(function (o, i) {
        var oid = q.id + '_' + i;
        h += '<label class="opt ' + (kind === 'radio' ? 'radio' : 'check') + '" for="' + oid + '" data-label="' + esc(o.label) + '">' +
          '<input type="' + kind + '" id="' + oid + '" name="' + q.id + '" value="' + esc(o.label) + '">' +
          '<span class="mark" aria-hidden="true"></span><span class="txt">' + esc(o.label) + '</span></label>';
        if (o.input) {
          h += '<div class="other-input" id="other-' + q.id + '" hidden>' +
            '<input class="field" type="text" maxlength="200" data-other="' + q.id + '" placeholder="请简单说明" autocomplete="off"></div>';
        }
      });
      h += '</div>';
      h += '<div class="hint" id="hint-' + q.id + '" hidden></div>';
    } else if (q.type === 'textarea') {
      h += '<textarea class="field" data-text="' + q.id + '" maxlength="' + q.maxLength + '" placeholder="' + esc(q.placeholder) + '"></textarea>';
      h += '<div class="counter" id="count-' + q.id + '">0/' + q.maxLength + '</div>';
    } else {
      h += '<input class="field" type="text" data-text="' + q.id + '" maxlength="' + q.maxLength + '" placeholder="' + esc(q.placeholder) + '" autocomplete="off">';
    }
    h += '<div class="err-msg">' + (q.type === 'multi' ? '请至少选择一项' : q.type === 'single' ? '请选择一项' : '请填写此题') + '</div>';
    h += '</div>';
    return h;
  }

  function renderForm() {
    var h = '';
    h += '<section class="card hero"><h1>' + esc(survey.title) + '</h1><p>' + esc(survey.intro) + '</p>' +
      '<div class="meta"><span class="chip">共 ' + survey.questions.length + ' 题</span><span class="chip">约 10 分钟</span><span class="chip">答案自动暂存</span></div>' +
      (restoredFromStorage ? '<div class="restored">已为你恢复上次未提交的内容，可以接着填写。</div>' : '') +
      '</section>';

    h += '<div class="card q" id="card-name"><h3 class="q-title"><span class="q-no">0.</span> ' + esc(survey.respondent.label) + '</h3>' +
      '<div class="q-tags"><span class="tag muted">选填</span></div>' +
      '<input class="field" type="text" id="nameInput" maxlength="' + (survey.respondent.maxLength || 50) + '" placeholder="' + esc(survey.respondent.placeholder) + '" autocomplete="off"></div>';

    survey.sections.forEach(function (s) {
      h += '<div class="section-head"><div class="section-letter">' + esc(s.id) + '</div><h2 class="section-title">' + esc(s.title) + '</h2></div>';
      s.questions.forEach(function (q) { h += renderQuestion(q); });
    });

    h += '<div class="submit-area"><button class="btn" id="submitBtn" type="button">提交问卷</button>' +
      '<div class="submit-err" id="submitErr" hidden></div>' +
      '<div class="submit-note">提交后不可修改，带 <span style="color:var(--err)">*</span> 的为必答题</div></div>';

    app.innerHTML = h;
    document.getElementById('progress').hidden = false;
    applyStateToDom();
    bind();
    updateProgress();
  }

  function renderThanks() {
    document.getElementById('progress').hidden = true;
    var t = survey.thanks || {};
    app.innerHTML = '<section class="card thanks">' +
      '<div class="ok"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--acc-ink)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>' +
      '<h2>' + esc(t.title || '提交成功') + '</h2><p>' + esc(t.text || '') + '</p>' +
      (state && state.submitted && state.submitted.id ? '<div class="sid">提交编号：' + esc(state.submitted.id) + '</div>' : '') +
      '</section>';
    window.scrollTo(0, 0);
  }

  function renderError(msg) {
    app.innerHTML = '<section class="card hero"><h1>问卷加载失败</h1><p>' + esc(msg) + '</p>' +
      '<div style="margin-top:18px"><button class="btn" type="button" onclick="location.reload()">重新加载</button></div></section>';
  }

  // ---------- 状态 → 界面 ----------
  function applyStateToDom() {
    document.getElementById('nameInput').value = state.name || '';
    survey.questions.forEach(function (q) {
      var v = state.answers[q.id];
      if (q.type === 'text' || q.type === 'textarea') {
        var el = app.querySelector('[data-text="' + q.id + '"]');
        el.value = v || '';
        updateCounter(q);
        return;
      }
      var chosen = Array.isArray(v) ? v : v ? [v] : [];
      var inputs = app.querySelectorAll('input[name="' + q.id + '"]');
      Array.prototype.forEach.call(inputs, function (inp) { inp.checked = chosen.indexOf(inp.value) > -1; });
      var oi = app.querySelector('[data-other="' + q.id + '"]');
      if (oi) oi.value = state.other[q.id] || '';
      refreshQuestion(q);
    });
  }

  function selectedOf(q) {
    var inputs = app.querySelectorAll('input[name="' + q.id + '"]');
    var out = [];
    Array.prototype.forEach.call(inputs, function (i) { if (i.checked) out.push(i.value); });
    return out;
  }

  // 根据当前选择刷新：选中样式、「最多 N 项」禁用、互斥项禁用、「其他」输入框
  function refreshQuestion(q) {
    var sel = selectedOf(q);
    var card = document.getElementById('card-' + q.id);
    var labels = card.querySelectorAll('.opt');
    var exclusiveOn = q.options.some(function (o) { return o.exclusive && sel.indexOf(o.label) > -1; });
    var full = q.type === 'multi' && q.maxSelect && sel.length >= q.maxSelect;
    Array.prototype.forEach.call(labels, function (lab, i) {
      var o = q.options[i];
      var inp = lab.querySelector('input');
      var on = inp.checked;
      var off = false;
      if (q.type === 'multi' && !on) {
        if (full) off = true;
        if (exclusiveOn && !o.exclusive) off = true;
      }
      inp.disabled = off;
      lab.className = 'opt ' + (q.type === 'single' ? 'radio' : 'check') + (on ? ' on' : '') + (off ? ' off' : '');
      if (o.input) {
        var box = document.getElementById('other-' + q.id);
        if (box) box.hidden = !on;
      }
    });
    var hint = document.getElementById('hint-' + q.id);
    if (hint) {
      if (exclusiveOn && sel.length) {
        hint.textContent = '已选「' + sel[0] + '」，其他选项不可同时选择';
        hint.hidden = false;
      } else if (full) {
        hint.textContent = '已选满 ' + q.maxSelect + ' 项，如需更换请先取消一项';
        hint.hidden = false;
      } else hint.hidden = true;
    }
  }

  function updateCounter(q) {
    var c = document.getElementById('count-' + q.id);
    if (!c) return;
    var el = app.querySelector('[data-text="' + q.id + '"]');
    c.textContent = el.value.length + '/' + q.maxLength;
  }

  function isAnswered(q) {
    var v = state.answers[q.id];
    if (q.type === 'text' || q.type === 'textarea') return !!(v && String(v).trim());
    if (q.type === 'multi') return Array.isArray(v) && v.length > 0;
    return !!v;
  }

  function updateProgress() {
    var total = survey.questions.length;
    var done = survey.questions.filter(isAnswered).length;
    document.getElementById('progressCount').textContent = done + '/' + total;
    document.getElementById('progressBar').style.width = (total ? (done / total) * 100 : 0) + '%';
  }

  function clearErr(q) {
    var card = document.getElementById('card-' + q.id);
    if (card && isAnswered(q)) card.classList.remove('has-err');
  }

  // ---------- 事件 ----------
  function bind() {
    app.addEventListener('change', function (e) {
      var t = e.target;
      if (t.type === 'radio' || t.type === 'checkbox') {
        var q = qById(t.name);
        if (!q) return;
        touch();
        if (q.type === 'single') {
          state.answers[q.id] = t.value;
        } else {
          var opt = null;
          for (var i = 0; i < q.options.length; i++) if (q.options[i].label === t.value) opt = q.options[i];
          // 选了互斥项（如「没用过」）→ 取消其他所有选项
          if (t.checked && opt && opt.exclusive) {
            Array.prototype.forEach.call(app.querySelectorAll('input[name="' + q.id + '"]'), function (x) { if (x !== t) x.checked = false; });
          }
          var sel = selectedOf(q);
          if (q.maxSelect && sel.length > q.maxSelect) { t.checked = false; sel = selectedOf(q); toast('最多选 ' + q.maxSelect + ' 项'); }
          if (sel.length) state.answers[q.id] = sel; else delete state.answers[q.id];
        }
        refreshQuestion(q);
        // 刚选中「其他」时聚焦输入框
        if (t.checked) {
          var o2 = null;
          for (var j = 0; j < q.options.length; j++) if (q.options[j].label === t.value) o2 = q.options[j];
          if (o2 && o2.input) {
            var oi = app.querySelector('[data-other="' + q.id + '"]');
            if (oi && !oi.value) setTimeout(function () { try { oi.focus(); } catch (e2) { /* ignore */ } }, 50);
          }
        }
        clearErr(q); updateProgress(); save();
      }
    });

    app.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'nameInput') { touch(); state.name = t.value; save(); return; }
      var oq = t.getAttribute('data-other');
      if (oq) { touch(); state.other[oq] = t.value; save(); return; }
      var tq = t.getAttribute('data-text');
      if (tq) {
        var q = qById(tq);
        touch();
        if (t.value) state.answers[tq] = t.value; else delete state.answers[tq];
        updateCounter(q); clearErr(q); updateProgress(); save();
      }
    });

    // 点被禁用的选项时给出提示（disabled 的 input 不会触发 change）
    app.addEventListener('click', function (e) {
      var lab = e.target.closest ? e.target.closest('.opt.off') : null;
      if (!lab) return;
      var card = lab.closest('.card');
      var q = qById(card.getAttribute('data-qid'));
      var hint = document.getElementById('hint-' + q.id);
      if (hint && !hint.hidden) toast(hint.textContent);
    });

    document.getElementById('submitBtn').addEventListener('click', submit);
  }

  // ---------- 提交 ----------
  function markErrors(ids) {
    survey.questions.forEach(function (q) {
      var card = document.getElementById('card-' + q.id);
      if (card) card.classList.toggle('has-err', ids.indexOf(q.id) > -1);
    });
    if (!ids.length) return;
    var first = document.getElementById('card-' + ids[0]);
    var top = first.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop) - 72;
    var cur = window.pageYOffset || document.documentElement.scrollTop;
    // 距离很远时直接跳过去，避免长时间平滑滚动
    if (Math.abs(cur - top) > 1500) window.scrollTo(0, top);
    else { try { window.scrollTo({ top: top, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, top); } }
    first.classList.remove('flash'); void first.offsetWidth; first.classList.add('flash');
  }

  function submit() {
    if (submitting || state.submitted) return;
    var errBox = document.getElementById('submitErr');
    errBox.hidden = true;
    var missing = survey.questions.filter(function (q) { return q.required && !isAnswered(q); }).map(function (q) { return q.id; });
    if (missing.length) {
      markErrors(missing);
      toast('还有 ' + missing.length + ' 道必答题未完成');
      errBox.textContent = '还有 ' + missing.length + ' 道必答题未完成，已为你标红';
      errBox.hidden = false;
      return;
    }
    tick();
    submitting = true;
    var btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = '正在提交…';

    var other = {};
    Object.keys(state.other).forEach(function (k) { if (state.other[k] && String(state.other[k]).trim()) other[k] = state.other[k]; });
    var payload = {
      clientId: state.clientId,
      name: state.name,
      answers: state.answers,
      other: other,
      durationSec: Math.round(state.activeMs / 1000),
      startedAt: state.startedAt,
    };

    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/submit', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 20000;
    xhr.onload = function () {
      var res = null;
      try { res = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status === 200 && res && res.ok) {
        state.submitted = { id: res.id, at: new Date().toISOString() };
        // 提交成功后只保留「已提交」标记，答案从本地清掉
        state.answers = {}; state.other = {}; state.name = '';
        save();
        renderThanks();
        return;
      }
      fail(xhr.status === 400 && res && res.fields ? res.fields : null, xhr.status === 429 ? '提交太频繁，请稍后再试' : null);
    };
    xhr.onerror = xhr.ontimeout = function () { fail(null, '网络异常，答案已保存在本机，请检查网络后重试'); };
    xhr.send(JSON.stringify(payload));

    function fail(fields, msg) {
      submitting = false;
      btn.disabled = false; btn.textContent = '提交问卷';
      if (fields && fields.length) {
        markErrors(fields);
        msg = '有 ' + fields.length + ' 道题需要检查，已为你标红';
      }
      msg = msg || '提交失败，请稍后重试';
      errBox.textContent = msg; errBox.hidden = false;
      toast(msg);
    }
  }

  // ---------- 启动 ----------
  function start(cfg) {
    survey = cfg;
    storeKey = 'designer-survey:' + survey.id;
    if (/[?&]reset=1\b/.test(location.search)) {
      clearStore();
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    }
    var saved = load(storeKey);
    if (saved && saved.clientId) {
      state = sanitize(saved);
      if (!state.submitted && (Object.keys(state.answers).length || state.name)) restoredFromStorage = true;
    } else {
      state = freshState();
    }
    if (state.submitted) { renderThanks(); return; }
    renderForm();
  }

  var req = new XMLHttpRequest();
  req.open('GET', 'api/survey', true);
  req.timeout = 15000;
  req.onload = function () {
    if (req.status !== 200) return renderError('服务器返回错误（' + req.status + '），请稍后重试。');
    try { start(JSON.parse(req.responseText)); } catch (e) { renderError('问卷数据解析失败：' + e.message); }
  };
  req.onerror = req.ontimeout = function () { renderError('网络连接失败，请检查网络后重新加载。'); };
  req.send();
})();
