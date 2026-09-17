/**
 * MedTwin AI — demo dashboard logic (vanilla JS, no build step).
 *
 * Three product widgets, all fed by real API data:
 *   1. Health Score Timeline    GET /api/members/:id/health-score
 *   2. Health Milestones        GET /api/members/:id/milestones
 *   3. Report Confidence Badge  badge field on /api/members/:id/reports
 *
 * CSP note: the API server sends `script-src 'self'` and forbids inline
 * handlers — everything here wires events with addEventListener and icons
 * come from ./icons.js (trusted markup constants only).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Icons = window.MtIcons;

  var state = {
    tokens: null,
    user: null,
    member: null,
    score: null,
    miles: null,
    reports: null,
    selectedDay: null,
    lastWidgetDataAt: 0,
  };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k]; // only ever trusted icon markup
        else if (k === 'title') node.title = attrs[k];
        else if (k === 'type') node.type = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function icon(name, size, cls) {
    return el('span', { class: 'btn-ic' + (cls ? ' ' + cls : ''), html: Icons.svg(name, size || 18) });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3800);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---------------------------------------------------------------- */
  /* API client with one-shot token refresh                            */
  /* ---------------------------------------------------------------- */

  function saveTokens(tokens) {
    state.tokens = tokens;
    try { localStorage.setItem('mt.tokens', JSON.stringify(tokens)); } catch (e) { /* private mode */ }
  }

  function loadTokens() {
    try {
      var raw = localStorage.getItem('mt.tokens');
      if (raw) state.tokens = JSON.parse(raw);
    } catch (e) { /* ignore */ }
  }

  function clearTokens() {
    state.tokens = null;
    try { localStorage.removeItem('mt.tokens'); } catch (e) { /* ignore */ }
  }

  function api(path, opts, allowRetry) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.tokens && state.tokens.accessToken) headers.Authorization = 'Bearer ' + state.tokens.accessToken;
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && allowRetry !== false && state.tokens && state.tokens.refreshToken) {
        return refreshSession().then(function (ok) {
          if (!ok) throw sessionExpired();
          return api(path, opts, false);
        });
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          var err = new Error((body && body.error && body.error.message) || 'Request failed (' + res.status + ')');
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      }, function () {
        throw new Error('Request failed (' + res.status + ')');
      });
    });
  }

  function sessionExpired() {
    clearTokens();
    showAuth();
    return new Error('Your session expired — please sign in again.');
  }

  function refreshSession() {
    return fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.tokens.refreshToken }),
    }).then(function (res) {
      if (!res.ok) return false;
      return res.json().then(function (body) {
        saveTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
        return true;
      });
    }).catch(function () { return false; });
  }

  /* ---------------------------------------------------------------- */
  /* auth view                                                         */
  /* ---------------------------------------------------------------- */

  var authMode = 'login';

  function showAuth() {
    $('dash-view').classList.add('hidden');
    $('userbox').classList.add('hidden');
    $('auth-view').classList.remove('hidden');
  }

  function showDash() {
    $('auth-view').classList.add('hidden');
    $('dash-view').classList.remove('hidden');
    $('userbox').classList.remove('hidden');
    $('user-email').textContent = state.user && state.user.email ? state.user.email : '';
  }

  function setAuthMode(mode) {
    authMode = mode;
    var isLogin = mode === 'login';
    $('tab-login').classList.toggle('active', isLogin);
    $('tab-register').classList.toggle('active', !isLogin);
    $('row-name').classList.toggle('hidden', isLogin);
    $('auth-heading').textContent = isLogin ? 'Welcome back' : 'Create your health twin';
    $('auth-submit').textContent = isLogin ? 'Sign in' : 'Create account';
    $('auth-error').classList.add('hidden');
  }

  function onAuthSubmit(ev) {
    ev.preventDefault();
    var email = $('in-email').value.trim();
    var password = $('in-password').value;
    var errBox = $('auth-error');
    errBox.classList.add('hidden');
    $('auth-submit').disabled = true;

    var promise;
    if (authMode === 'login') {
      promise = api('/auth/login', { method: 'POST', body: { email: email, password: password } }, false);
    } else {
      promise = api('/auth/register', {
        method: 'POST',
        body: { email: email, displayName: $('in-name').value.trim() || email.split('@')[0], password: password },
      }, false);
    }

    promise.then(function (session) {
      saveTokens({ accessToken: session.accessToken, refreshToken: session.refreshToken });
      state.user = session.user;
      return bootDashboard();
    }).catch(function (err) {
      errBox.textContent = err.message || 'Something went wrong';
      errBox.classList.remove('hidden');
    }).finally(function () {
      $('auth-submit').disabled = false;
    });
  }

  function onLogout() {
    var rt = state.tokens && state.tokens.refreshToken;
    clearTokens();
    state.user = null;
    state.member = null;
    showAuth();
    if (rt) {
      api('/auth/logout', { method: 'POST', body: { refreshToken: rt } }, false).catch(function () { /* best effort */ });
    }
  }

  /* ---------------------------------------------------------------- */
  /* dashboard bootstrap                                               */
  /* ---------------------------------------------------------------- */

  function bootDashboard() {
    return api('/members').then(function (body) {
      var owned = body.owned || [];
      var shared = body.shared || [];
      var all = owned.concat(shared);
      if (all.length === 0) throw new Error('No health twin member found on this account.');
      state.member =
        owned.find(function (m) { return m.relationship === 'self'; }) || owned[0] || all[0];
      $('member-name').textContent = state.member.name;
      $('member-sub').textContent = (state.member.relationship || 'self') + ' · digital health twin';
      showDash();
      return refreshAll();
    }).catch(function (err) {
      if (err.status === 401) throw err;
      toast(err.message || 'Could not load your health twin');
    });
  }

  function refreshAll() {
    if (!state.member) return Promise.resolve();
    var id = state.member.id;
    return Promise.all([
      api('/members/' + id + '/health-score').catch(function () { return null; }),
      api('/members/' + id + '/milestones').catch(function () { return null; }),
      api('/members/' + id + '/reports?pageSize=50').catch(function () { return null; }),
    ]).then(function (results) {
      state.score = results[0];
      state.miles = results[1];
      state.reports = results[2];
      state.lastWidgetDataAt = Date.now();
      renderScore();
      renderMilestones();
      renderReports();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Widget 1 — Health Score Timeline                                  */
  /* ---------------------------------------------------------------- */

  var BAND_TONE = { strong: 'green', good: 'green', watch: 'amber', attention: 'red' };
  var BAND_LABEL = { strong: 'Strong', good: 'Good', watch: 'Watch', attention: 'Attention' };

  function currentSnapshot() {
    var tl = state.score && state.score.timeline ? state.score.timeline : [];
    if (!tl.length) return null;
    return tl.find(function (s) { return s.day === state.selectedDay; }) || tl[tl.length - 1];
  }

  function renderScore() {
    var body = $('score-body');
    body.innerHTML = '';
    var data = state.score;

    if (!data) {
      body.appendChild(emptyState('activity', 'Health score unavailable right now.'));
      return;
    }
    if (!data.timeline || data.timeline.length === 0) {
      body.appendChild(emptyState('activity', data.message || 'Upload and verify a report to start your health score timeline.'));
      body.appendChild(disclaimerBox(data.disclaimer));
      return;
    }

    if (!state.selectedDay || !data.timeline.some(function (s) { return s.day === state.selectedDay; })) {
      state.selectedDay = data.timeline[data.timeline.length - 1].day;
    }

    var cur = data.current;
    var snap = currentSnapshot();

    // ---- hero: ring + band + delta --------------------------------
    var hero = el('div', { class: 'score-hero' });
    hero.appendChild(scoreRing(cur.score, cur.band));
    var meta = el('div', { class: 'score-meta' });
    var chips = el('div');
    chips.appendChild(el('span', { class: 'chip ' + (BAND_TONE[cur.band] || 'grey'), text: BAND_LABEL[cur.band] || cur.band }));
    chips.appendChild(document.createTextNode(' '));
    chips.appendChild(deltaChip(cur.delta));
    meta.appendChild(chips);
    meta.appendChild(el('p', { class: 'asof', text:
      'As of ' + cur.label + ' · ' + plural(cur.markerCount, 'marker', 'markers') + ' · ' +
      plural(cur.outOfRangeCount, 'value', 'values') + ' outside range' }));
    meta.appendChild(el('p', { class: 'asof', text: 'Score = share of verified markers inside their reference ranges.' }));
    hero.appendChild(meta);
    body.appendChild(hero);

    // ---- chart -----------------------------------------------------
    var chartWrap = el('div', { class: 'chart-wrap' });
    chartWrap.appendChild(buildChart(data.timeline));
    body.appendChild(chartWrap);

    // ---- per-snapshot breakdown ------------------------------------
    body.appendChild(breakdownView(snap));
    body.appendChild(disclaimerBox(data.disclaimer));
  }

  function scoreRing(score, band) {
    var tone = { strong: '#0d9488', good: '#22a06b', watch: '#d97706', attention: '#dc2626' }[band] || '#6b8291';
    var r = 46;
    var c = 2 * Math.PI * r;
    var filled = Math.max(0, Math.min(100, score)) / 100 * c;
    var svg =
      '<svg width="108" height="108" viewBox="0 0 108 108">' +
      '<circle cx="54" cy="54" r="' + r + '" fill="none" stroke="#e8eef3" stroke-width="10"/>' +
      '<circle cx="54" cy="54" r="' + r + '" fill="none" stroke="' + tone + '" stroke-width="10" stroke-linecap="round" ' +
      'stroke-dasharray="' + filled.toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 54 54)"/></svg>';
    var ring = el('div', { class: 'ring', html: svg });
    var val = el('div', { class: 'ring-val' });
    val.appendChild(el('b', { text: String(score) }));
    val.appendChild(el('span', { text: '/ 100' }));
    ring.appendChild(val);
    return ring;
  }

  function deltaChip(delta) {
    if (delta == null) return el('span', { class: 'chip grey', text: 'first snapshot' });
    if (delta === 0) {
      var c0 = el('span', { class: 'chip grey' });
      c0.appendChild(icon('minus', 13));
      c0.appendChild(document.createTextNode('no change'));
      return c0;
    }
    var up = delta > 0;
    var c = el('span', { class: 'chip ' + (up ? 'green' : 'red') });
    c.appendChild(icon(up ? 'arrow-up-right' : 'arrow-down-right', 13));
    c.appendChild(document.createTextNode((up ? '+' : '') + delta + ' vs previous'));
    return c;
  }

  function buildChart(timeline) {
    var NS = 'http://www.w3.org/2000/svg';
    var host = document.createElement('div');
    var W = Math.max(300, ($('score-body').clientWidth || 340) - 2);
    var H = 208;
    var padL = 30, padR = 12, padT = 18, padB = 34;
    var n = timeline.length;

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');

    var defs = document.createElementNS(NS, 'defs');
    defs.innerHTML =
      '<linearGradient id="scoreGradient" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#0d9488" stop-opacity="0.25"/>' +
      '<stop offset="100%" stop-color="#0d9488" stop-opacity="0"/></linearGradient>';
    svg.appendChild(defs);

    function px(i) {
      if (n === 1) return (padL + W - padR) / 2;
      return padL + (i * (W - padL - padR)) / (n - 1);
    }
    function py(score) {
      return padT + ((100 - score) / 100) * (H - padT - padB);
    }

    // band gridlines
    [60, 75, 90, 100].forEach(function (g) {
      var line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
      line.setAttribute('y1', py(g)); line.setAttribute('y2', py(g));
      line.setAttribute('class', 'chart-grid');
      svg.appendChild(line);
      var lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', '2'); lbl.setAttribute('y', py(g) + 3.5);
      lbl.setAttribute('class', 'chart-xlab');
      lbl.textContent = String(g);
      svg.appendChild(lbl);
    });

    // area
    if (n >= 2) {
      var d = 'M ' + px(0) + ' ' + py(timeline[0].score);
      for (var i = 1; i < n; i += 1) d += ' L ' + px(i) + ' ' + py(timeline[i].score);
      var area = document.createElementNS(NS, 'path');
      area.setAttribute('d', d + ' L ' + px(n - 1) + ' ' + py(0) + ' L ' + px(0) + ' ' + py(0) + ' Z');
      area.setAttribute('class', 'chart-area');
      svg.appendChild(area);
      var line2 = document.createElementNS(NS, 'path');
      line2.setAttribute('d', d);
      line2.setAttribute('class', 'chart-line');
      svg.appendChild(line2);
    }

    // dots + labels
    timeline.forEach(function (s, i) {
      var x = px(i);
      var y = py(s.score);
      var isSel = s.day === state.selectedDay;

      var lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', x); lbl.setAttribute('y', y - 12);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('class', 'chart-scorelab');
      lbl.textContent = String(s.score);
      svg.appendChild(lbl);

      var dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y);
      dot.setAttribute('r', isSel ? 6 : 4.5);
      dot.setAttribute('class', 'chart-dot' + (isSel ? ' sel' : ''));
      dot.addEventListener('click', function () {
        state.selectedDay = s.day;
        renderScore();
      });
      var title = document.createElementNS(NS, 'title');
      title.textContent = s.label + ' — score ' + s.score;
      dot.appendChild(title);
      svg.appendChild(dot);

      var mon = document.createElementNS(NS, 'text');
      mon.setAttribute('x', x); mon.setAttribute('y', H - 12);
      mon.setAttribute('text-anchor', 'middle');
      mon.setAttribute('class', 'chart-xlab');
      mon.setAttribute('style', 'font-size:11px');
      mon.textContent = s.label;
      svg.appendChild(mon);

      // delta under the month — the "Jan → 68 | Mar → 72" strip
      if (s.delta != null) {
        var dl = document.createElementNS(NS, 'text');
        dl.setAttribute('x', x); dl.setAttribute('y', H - 1);
        dl.setAttribute('text-anchor', 'middle');
        dl.setAttribute('style', 'font-size:10px;font-weight:700;fill:' + (s.delta > 0 ? '#15803d' : s.delta < 0 ? '#b91c1c' : '#6b8291'));
        dl.textContent = (s.delta > 0 ? '+' : '') + s.delta;
        svg.appendChild(dl);
      }
    });

    host.appendChild(svg);
    return host;
  }

  function breakdownView(snap) {
    var box = el('div', { class: 'breakdown' });
    box.appendChild(el('h3', { text: 'What makes up the ' + snap.label + ' score' }));
    snap.breakdown.forEach(function (b) {
      var row = el('div', { class: 'bk-row' });
      row.appendChild(el('span', { class: 'bk-name', text: b.markerName }));
      var val = b.value != null ? b.value + (b.unit ? ' ' + b.unit : '') : '—';
      row.appendChild(el('span', {
        class: 'bk-val ' + (b.status === 'normal' ? 'ok' : b.status === 'unknown' ? 'unknown' : 'bad'),
        text: val + (b.status !== 'normal' && b.status !== 'unknown' ? ' (' + b.status + ')' : ''),
      }));
      row.appendChild(el('span', {
        class: 'bk-pts ' + (b.points >= 100 ? 'ok' : b.points <= 45 ? 'bad' : 'unknown'),
        text: b.points + ' pts',
      }));
      box.appendChild(row);
    });
    return box;
  }

  /* ---------------------------------------------------------------- */
  /* Widget 2 — Health Milestones                                      */
  /* ---------------------------------------------------------------- */

  function renderMilestones() {
    var body = $('miles-body');
    body.innerHTML = '';
    var data = state.miles;
    if (!data) {
      body.appendChild(emptyState('trophy', 'Milestones unavailable right now.'));
      return;
    }
    $('mile-sub').textContent = data.earned + ' of ' + data.total + ' earned';

    var prog = el('div', { class: 'miles-progress' });
    var barOuter = el('div', { class: 'bar' });
    var w = data.total ? Math.round((data.earned / data.total) * 100) : 0;
    barOuter.appendChild(el('i', { style: 'width:' + w + '%' }));
    prog.appendChild(barOuter);
    prog.appendChild(el('b', { text: data.earned + '/' + data.total }));
    body.appendChild(prog);

    var grid = el('div', { class: 'miles' });
    data.milestones.forEach(function (m) {
      var isNext = data.next && data.next.key === m.key;
      var card = el('div', { class: 'mile' + (m.achieved ? ' done' : '') + (isNext ? ' next' : '') });
      if (isNext) card.appendChild(el('span', { class: 'next-tag', text: 'Up next' }));
      card.appendChild(el('span', { class: 'm-ic', html: Icons.svg(m.icon, 18) }));

      var mbody = el('div', { class: 'm-body' });
      mbody.appendChild(el('div', { class: 'm-title', text: m.title }));
      mbody.appendChild(el('p', { class: 'm-desc', text: m.description }));

      if (m.achieved) {
        mbody.appendChild(el('div', { class: 'm-when', text: 'Earned ' + fmtDate(m.achievedAt) }));
      } else if (m.progress && m.progress.requiredDays) {
        var days = m.progress.daysCovered;
        var pct = Math.max(2, Math.min(100, Math.round((days / m.progress.requiredDays) * 100)));
        var bar = el('div', { class: 'bar' });
        bar.appendChild(el('i', { style: 'width:' + pct + '%' }));
        mbody.appendChild(bar);
        mbody.appendChild(el('div', {
          class: 'm-prog',
          text: days + ' of ~' + m.progress.requiredDays + ' days of verified history',
        }));
      }
      card.appendChild(mbody);
      card.appendChild(el('span', {
        class: m.achieved ? 'm-check' : 'm-lock',
        html: Icons.svg(m.achieved ? 'circle-check' : 'lock', 16),
      }));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  /* ---------------------------------------------------------------- */
  /* Widget 3 — Reports with Confidence Badges                         */
  /* ---------------------------------------------------------------- */

  function renderReports() {
    var body = $('reports-body');
    body.innerHTML = '';
    var data = state.reports;
    if (!data) {
      body.appendChild(emptyState('file-text', 'Reports unavailable right now.'));
      return;
    }
    if (!data.items || data.items.length === 0) {
      body.appendChild(emptyState('file-text', 'No reports yet — scan one with your camera or paste its text; the pipeline drafts values for your review.'));
      return;
    }

    var list = el('div', { class: 'reports-list' });
    data.items.forEach(function (r) {
      var row = el('div', { class: 'report' });

      var head = el('div', { class: 'r-head' });
      head.appendChild(icon('file-text', 18, 'r-ic'));
      head.appendChild(el('span', { class: 'r-name', text: r.originalName || 'Pasted report' }));
      head.appendChild(el('span', { class: 'r-date', text: fmtDate(r.reportDate || r.createdAt) }));
      row.appendChild(head);

      var actions = el('div', { class: 'r-actions' });
      if (r.badge && r.badge.level === 'needs_review' && r.labResultCount > 0) {
        var btn = el('button', { class: 'btn primary sm', type: 'button', title: 'Confirm the extracted values' });
        btn.appendChild(icon('badge-check', 14));
        btn.appendChild(document.createTextNode('Verify'));
        btn.addEventListener('click', function () { verifyReport(r.id); });
        actions.appendChild(btn);
      } else if (r.labResultCount != null) {
        actions.appendChild(el('span', { class: 'r-date', text: plural(r.labResultCount, 'value', 'values') }));
      }
      row.appendChild(actions);

      if (r.badge) {
        var badge = el('span', { class: 'badge ' + (r.badge.tone || 'grey'), title: r.badge.hint || '' });
        badge.appendChild(el('span', { class: 'btn-ic', html: Icons.svg(r.badge.icon, 14) }));
        badge.appendChild(document.createTextNode(r.badge.label));
        row.appendChild(el('div', { class: 'r-badge' }, [badge]));
        if (r.badge.hint) row.appendChild(el('p', { class: 'r-hint', text: r.badge.hint }));
      }

      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function verifyReport(reportId) {
    api('/reports/' + reportId + '/verify', { method: 'POST', body: {} })
      .then(function () {
        toast('Report verified — your twin just grew. Watch the score and milestones.');
        return refreshAll();
      })
      .catch(function (err) { toast(err.message || 'Verification failed'); });
  }

  function onUpload(ev) {
    ev.preventDefault();
    var text = $('in-report-text').value.trim();
    var date = $('in-report-date').value;
    var errBox = $('upload-error');
    errBox.classList.add('hidden');
    if (!text) {
      errBox.textContent = 'Paste the report text first.';
      errBox.classList.remove('hidden');
      return;
    }
    if (!state.member) return;
    $('btn-upload').disabled = true;
    api('/members/' + state.member.id + '/reports', {
      method: 'POST',
      body: { text: text, reportDate: date || null },
    }).then(function (out) {
      $('in-report-text').value = '';
      var badge = out && out.report && out.report.badge ? out.report.badge.label : 'Needs review';
      toast('Scanned — badge: ' + badge + '. Verify it to feed your twin.');
      return refreshAll();
    }).catch(function (err) {
      errBox.textContent = err.message || 'Upload failed';
      errBox.classList.remove('hidden');
    }).finally(function () {
      $('btn-upload').disabled = false;
    });
  }

  /* ---------------------------------------------------------------- */
  /* multipart upload helper (files can't go through the JSON api())   */
  /* ---------------------------------------------------------------- */

  function apiUpload(path, formData, allowRetry) {
    var headers = {};
    if (state.tokens && state.tokens.accessToken) headers.Authorization = 'Bearer ' + state.tokens.accessToken;
    return fetch('/api' + path, { method: 'POST', headers: headers, body: formData }).then(function (res) {
      // Same one-shot session refresh as api(): uploads must not hard-fail
      // just because the 15-minute access token expired mid-demo.
      if (res.status === 401 && allowRetry !== false && state.tokens && state.tokens.refreshToken) {
        return refreshSession().then(function (ok) {
          if (!ok) throw sessionExpired();
          return apiUpload(path, formData, false);
        });
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          var err = new Error((body && body.error && body.error.message) || 'Upload failed (' + res.status + ')');
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      }, function () {
        // Non-JSON error body (proxy / connection edge) — still report status.
        throw new Error('Upload failed (' + res.status + ')');
      });
    });
  }

  function ingestFile(file, source) {
    var fd = new FormData();
    fd.append('file', file, file.name || (source === 'camera' ? 'camera-scan.jpg' : 'upload.jpg'));
    return apiUpload('/members/' + state.member.id + '/reports', fd);
  }

  /* ---------------------------------------------------------------- */
  /* Phone-first #1 — camera report scanner                            */
  /* ---------------------------------------------------------------- */

  var scanStream = null;

  function openScanner() {
    var view = $('scanner-view');
    var err = $('scan-error');
    err.hidden = true;
    view.classList.remove('hidden');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // No camera API (older browsers / non-secure context) — offer gallery.
      err.textContent = 'Live camera unavailable here — use the Gallery button to pick a photo.';
      err.hidden = false;
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        scanStream = stream;
        var video = $('scan-video');
        video.srcObject = stream;
        video.play().catch(function () { /* autoplay quirks */ });
      })
      .catch(function () {
        err.textContent = 'Could not open the camera — grant permission, or use Gallery.';
        err.hidden = false;
      });
  }

  function closeScanner() {
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
    }
    $('scan-video').srcObject = null;
    $('scanner-view').classList.add('hidden');
  }

  // Phone sensors (12–200MP) produce frames far larger than any server
  // should accept — and Tesseract reads documents better at moderate
  // resolution anyway. Everything uploaded is shrunk to <=1600px / JPEG.
  var SCAN_MAX_EDGE = 1600;

  function canvasToJpeg(canvas, name, done) {
    canvas.toBlob(function (blob) {
      if (!blob) { toast('Could not capture the frame.'); return; }
      done(new File([blob], name, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.85);
  }

  function drawScaled(img, imgW, imgH, name, done) {
    var scale = Math.min(1, SCAN_MAX_EDGE / Math.max(imgW, imgH));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(imgW * scale));
    canvas.height = Math.max(1, Math.round(imgH * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    canvasToJpeg(canvas, name, done);
  }

  /** Shrink a gallery/camera file client-side; falls back to the original on any error. */
  function shrinkImage(file, name, done) {
    if (!file || !/^image\//.test(file.type || '')) { done(file); return; }
    var url;
    try { url = URL.createObjectURL(file); } catch (e) { done(file); return; }
    var img = new Image();
    img.onload = function () {
      try {
        URL.revokeObjectURL(url);
        if (!img.naturalWidth) { done(file); return; }
        drawScaled(img, img.naturalWidth, img.naturalHeight, name, done);
      } catch (e) { done(file); }
    };
    img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} done(file); };
    img.src = url;
  }

  function captureFrame() {
    var video = $('scan-video');
    if (!video.videoWidth) { toast('Camera not ready yet.'); return; }
    closeScanner();
    drawScaled(video, video.videoWidth, video.videoHeight, 'camera-scan.jpg', function (file) {
      submitCapture(file, 'camera');
    });
  }

  function submitCapture(file, source) {
    toast('Reading your report…');
    ingestFile(file, source)
      .then(function (out) {
        var badge = out && out.report && out.report.badge ? out.report.badge.label : 'Needs review';
        var count = out && out.preview && out.preview.extracted ? out.preview.extracted.length : 0;
        toast('Scanned ' + count + ' value' + (count === 1 ? '' : 's') + ' — badge: ' + badge + '. Verify to feed your twin.');
        return refreshAll();
      })
      .catch(function (err) { toast(err.message || 'Scan failed'); });
  }

  /* ---------------------------------------------------------------- */
  /* Phone-first #2 — voice journaling (on-device speech)              */
  /* ---------------------------------------------------------------- */

  var recognition = null;
  var listening = false;

  function speechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function toggleVoice() {
    var err = $('voice-error');
    err.classList.add('hidden');
    var Ctor = speechCtor();
    if (!Ctor) {
      err.textContent = 'Voice input needs a browser with speech recognition (Chrome on the iQOO works).';
      err.classList.remove('hidden');
      return;
    }
    if (listening) { stopVoice(); return; }

    recognition = new Ctor();
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    listening = true;
    setVoiceUI(true);

    recognition.onresult = function (ev) {
      var text = ev.results[0][0].transcript;
      $('voice-transcript').textContent = '“' + text + '”';
      $('voice-transcript').classList.remove('hidden');
      saveVoiceObservation(text);
    };
    recognition.onerror = function (ev) {
      stopVoice();
      err.textContent = 'Voice error: ' + (ev && ev.error ? ev.error : 'unknown');
      err.classList.remove('hidden');
    };
    recognition.onend = function () { stopVoice(); };
    recognition.start();
  }

  function stopVoice() {
    listening = false;
    setVoiceUI(false);
    try { recognition && recognition.stop(); } catch (e) { /* already stopped */ }
  }

  function setVoiceUI(active) {
    var label = $('voice-label');
    label.textContent = active ? 'Listening… tap to stop' : 'Start voice journal';
    Icons.set($('voice-icon'), active ? 'stop' : 'mic', 16);
    $('btn-voice').classList.toggle('listening', active);
  }

  /** Deterministic, rule-based mapping of a spoken sentence to an observation. */
  function parseObservation(text) {
    var t = (text || '').toLowerCase();
    var num = (t.match(/(\d+(?:\.\d+)?)/) || [null, null])[1];
    if (/sleep|slept|soya|neend/.test(t)) return { kind: 'sleep', payload: { note: text, quality: /bad|poor|kharab|badly/.test(t) ? 'poor' : 'good' } };
    if (/walk|run|exercise|gym|workout|vyayam/.test(t)) return { kind: 'activity', payload: { note: text, minutes: num ? Number(num) : null } };
    if (/weight|wajan|vajan|kg/.test(t)) return { kind: 'weight', payload: { note: text, kg: num ? Number(num) : null } };
    if (/blood pressure|bp\b|pressure/.test(t)) return { kind: 'bp', payload: { note: text, reading: num } };
    if (/medicine|tablet|dawai|medication|dose/.test(t)) return { kind: 'medication', payload: { note: text } };
    return { kind: 'symptom', payload: { note: text } };
  }

  function saveVoiceObservation(text) {
    if (!state.member) return;
    var obs = parseObservation(text);
    api('/members/' + state.member.id + '/observations', {
      method: 'POST',
      body: { kind: obs.kind, payload: obs.payload, source: 'voice' },
    })
      .then(function () { toast('Voice note saved as a ' + obs.kind + ' observation.'); return refreshAll(); })
      .catch(function (err) { toast(err.message || 'Could not save the voice note'); });
  }

  /* ---------------------------------------------------------------- */
  /* Phone-first #3 — installable PWA (service worker)                 */
  /* ---------------------------------------------------------------- */

  function setTab(tab) {
    var home = $('nav-home');
    var reports = $('nav-reports');
    home.classList.toggle('active', tab === 'home');
    reports.classList.toggle('active', tab === 'reports');
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* offline is optional */ });
    }
  }

  /* ---------------------------------------------------------------- */
  /* shared bits                                                       */
  /* ---------------------------------------------------------------- */

  function emptyState(iconName, msg) {
    var box = el('div', { class: 'empty' });
    box.appendChild(el('span', { class: 'btn-ic', html: Icons.svg(iconName, 28) }));
    box.appendChild(el('p', { class: 'muted', text: msg }));
    return box;
  }

  function disclaimerBox(text) {
    if (!text) return el('div');
    var box = el('div', { class: 'disclaimer' });
    box.appendChild(icon('info', 15));
    box.appendChild(el('span', { text: text }));
    return box;
  }

  /* ---------------------------------------------------------------- */
  /* init                                                              */
  /* ---------------------------------------------------------------- */

  function setStaticIcons() {
    [['brand-logo', 'pulse', 22], ['user-icon', 'user', 16], ['logout-icon', 'log-out', 15],
     ['member-icon', 'user', 18], ['refresh-icon', 'refresh-cw', 15], ['score-head-ic', 'activity', 19],
     ['mile-head-ic', 'trophy', 19], ['rep-head-ic', 'file-text', 19], ['upload-icon', 'upload', 15],
     ['scan-icon', 'camera', 18], ['voice-head-ic', 'mic', 19],
    ].forEach(function (t) { Icons.set($(t[0]), t[1], t[2]); });
    // bottom nav + scanner buttons
    Icons.set(document.querySelector('#nav-home .nav-ic'), 'home', 20);
    Icons.set(document.querySelector('#nav-reports .nav-ic'), 'file-text', 20);
    Icons.set(document.querySelector('#nav-scan .nav-ic'), 'camera', 26);
    Icons.set(document.querySelector('#scan-close .btn-ic'), 'x', 16);
    Icons.set(document.querySelector('#scan-capture .btn-ic'), 'camera', 20);
    Icons.set(document.querySelector('#scan-gallery .btn-ic'), 'upload', 16);
    Icons.set($('voice-icon'), 'mic', 16);
  }

  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.score && state.score.timeline && state.score.timeline.length) renderScore();
    }, 220);
  }

  function init() {
    setStaticIcons();
    $('tab-login').addEventListener('click', function () { setAuthMode('login'); });
    $('tab-register').addEventListener('click', function () { setAuthMode('register'); });
    $('auth-form').addEventListener('submit', onAuthSubmit);
    $('btn-logout').addEventListener('click', onLogout);
    $('btn-refresh').addEventListener('click', function () { refreshAll().then(function () { toast('Refreshed.'); }); });
    $('upload-form').addEventListener('submit', onUpload);
    window.addEventListener('resize', onResize);

    // phone-first: camera scanner, gallery fallback, voice journal, bottom nav
    $('btn-scan').addEventListener('click', openScanner);
    $('nav-scan').addEventListener('click', openScanner);
    $('scan-close').addEventListener('click', closeScanner);
    $('scan-capture').addEventListener('click', captureFrame);
    $('scan-file').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = ''; // allow re-picking the same photo
      if (f) {
        closeScanner();
        toast('Preparing photo…');
        shrinkImage(f, 'gallery-scan.jpg', function (small) { submitCapture(small, 'gallery'); });
      }
    });
    $('btn-voice').addEventListener('click', toggleVoice);
    $('nav-home').addEventListener('click', function () { setTab('home'); scrollTo(0, 0); });
    $('nav-reports').addEventListener('click', function () {
      setTab('reports');
      var r = document.querySelector('.widget-reports');
      if (r) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    registerServiceWorker();
    loadTokens();
    if (state.tokens && state.tokens.accessToken) {
      api('/auth/me').then(function (me) {
        state.user = me.user;
        return bootDashboard();
      }).catch(function () { showAuth(); });
    } else {
      showAuth();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
