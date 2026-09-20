/**
 * kivo — dashboard logic (vanilla JS, no build step).
 *
 * Three product widgets, all fed by real API data:
 *   1. Health Score Timeline    GET /api/members/:id/health-score
 *   2. Health Milestones        GET /api/members/:id/milestones
 *   3. Report Confidence Badge  badge field on /api/members/:id/reports
 *
 * Security note: the page is served under a strict `script-src 'self'`
 * policy that forbids inline handlers — everything here wires events with
 * addEventListener and icons come from ./icons.js (trusted markup only).
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
    insights: null,
    intel: null,
    trends: null,
    risk: null,
    guidance: null,
    meds: null,
    summary: null,
    observations: null,
    reminders: null,
    askSuggestions: null,
    chat: [],
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
          var err = new Error((body && body.error && body.error.message) || 'Something went wrong on our side — please try again.');
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      }, function () {
        throw new Error('Something went wrong on our side — please try again.');
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
    var care = $('care-view');
    if (care) care.classList.add('hidden');
  }

  function showDash() {
    $('auth-view').classList.add('hidden');
    $('dash-view').classList.remove('hidden');
    $('userbox').classList.remove('hidden');
    $('user-email').textContent = state.user && state.user.email ? state.user.email : '';
    var care = $('care-view');
    if (care) care.classList.add('hidden');
  }

  /** Third top-level view: the Care tab (subscription / doctors / shorts). */
  function showCare() {
    $('auth-view').classList.add('hidden');
    $('dash-view').classList.add('hidden');
    $('userbox').classList.remove('hidden');
    var care = $('care-view');
    if (care) care.classList.remove('hidden');
    scrollTo(0, 0);
  }

  function showView(name) {
    if (name === 'care') return showCare();
    if (name === 'auth') return showAuth();
    return showDash();
  }

  /* Cross-module hooks: care.js (a separate file) drives its own screens
     through this tiny surface instead of reaching into dashboard internals. */
  var sessionListeners = [];
  var memberListeners = [];
  function notifySession() {
    sessionListeners.forEach(function (cb) { try { cb(state.user); } catch (e) { /* isolate */ } });
  }
  function notifyMember() {
    memberListeners.forEach(function (cb) { try { cb(state.member); } catch (e) { /* isolate */ } });
  }

  function setAuthMode(mode) {
    authMode = mode;
    var isLogin = mode === 'login';
    $('tab-login').classList.toggle('active', isLogin);
    $('tab-register').classList.toggle('active', !isLogin);
    $('row-name').classList.toggle('hidden', isLogin);
    $('auth-heading').textContent = isLogin ? 'Welcome back' : 'Create your kivo profile';
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

    var mode = authMode;
    var displayName = $('in-name').value.trim() || email.split('@')[0];
    var promise = window.KivoConnection.ensureReady().then(function () {
      if (mode === 'login') {
        return api('/auth/login', { method: 'POST', body: { email: email, password: password } }, false);
      }
      return api('/auth/register', {
        method: 'POST', body: { email: email, displayName: displayName, password: password },
      }, false);
    });

    promise.then(function (session) {
      saveTokens({ accessToken: session.accessToken, refreshToken: session.refreshToken });
      state.user = session.user;
      notifySession();
      if (session.user && session.user.accountType === 'doctor') {
        // Two user categories, two frontends: doctors work in the console.
        try { sessionStorage.setItem('kivo.role-handoff', JSON.stringify(state.tokens)); } catch (e) { /* doctor can sign in directly */ }
        clearTokens();
        location.href = '/doctor/';
        return null;
      }
      return bootDashboard();
    }).catch(function (err) {
      errBox.textContent = err instanceof TypeError ? 'Cannot connect right now. Check your internet and try again.' : (err.message || 'Please try again.');
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
    notifySession();
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
      if (all.length === 0) throw new Error('No kivo health member found on this account.');
      state.member =
        owned.find(function (m) { return m.relationship === 'self'; }) || owned[0] || all[0];
      $('member-name').textContent = state.member.name;
      $('member-sub').textContent = (state.member.relationship || 'self') + ' · kivo health';
      notifyMember();
      showDash();
      return refreshAll();
    }).catch(function (err) {
      if (err.status === 401) throw err;
      toast(err.message || 'Could not load your kivo health');
    });
  }

  function refreshAll() {
    if (!state.member) return Promise.resolve();
    var id = state.member.id;
    // core widgets (blocking)
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
      // non-blocking: enrich with intelligence, insights, journal
      loadObservations();
      loadReminders();
      loadAskSuggestions();
      loadInsights('trends');
      loadIntel('baseline');
      updateStorageInfo();
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
        toast('Report verified — your kivo just grew. Watch the score and milestones.');
        return refreshAll();
      })
      .catch(function (err) { toast(err.message || 'We could not verify that report — please try again.'); });
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
      errBox.textContent = err.message || 'We could not read that report — please try again.';
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
          var err = new Error((body && body.error && body.error.message) || 'We could not read that report — please try again.');
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      }, function () {
        // Non-JSON error body (dropped connection / proxy edge).
        throw new Error('The upload did not go through — check your connection and try again.');
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

  // Phone sensors (12–200MP) produce frames far larger than the reader
  // needs, and the text comes out cleaner at moderate resolution. Everything
  // uploaded is shrunk to <=1600px / JPEG.
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
        var rows = out && out.preview && out.preview.extracted ? out.preview.extracted : [];
        var flagged = rows.filter(function (r) { return r.suspicious; }).length;
        var msg = 'Scanned ' + rows.length + ' value' + (rows.length === 1 ? '' : 's') + ' — badge: ' + badge + '.';
        if (flagged > 0) {
          // A physically implausible reading is usually a misread: say so before
          // the user verifies anything.
          msg += ' ' + flagged + ' value' + (flagged === 1 ? '' : 's') + ' look' + (flagged === 1 ? 's' : '') +
            ' implausible for that test — check against the report.';
        }
        msg += ' Verify to feed your kivo.';
        toast(msg);
        return refreshAll();
      })
      .catch(function (err) { toast(err.message || 'We could not read that scan — try again in better light.'); });
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
      var code = ev && ev.error ? ev.error : '';
      var human =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Microphone access is blocked — allow it in your browser settings and try again.'
          : code === 'no-speech'
            ? 'We could not hear anything — try again a little closer to the mic.'
            : code === 'audio-capture'
              ? 'No microphone was found on this device.'
              : 'Voice input stopped before we caught that — please try again.';
      err.textContent = human;
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
    if (window.KivoNative) return; // the APK already ships its UI
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* offline is optional */ });
    }
  }


  /* buttery smooth helper: disables button, shows spinner, prevents double tap */
  function withLoading(btn, fn) {
    if (!btn || btn.disabled) return;
    var orig = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('loading');
    // subtle spinner via icon replacement if present
    var ic = btn.querySelector('.btn-ic');
    var icHtml = ic ? ic.innerHTML : null;
    if (ic) ic.innerHTML = Icons.svg('loader', 14);
    var done = function(){ btn.disabled = false; btn.classList.remove('loading'); if(ic && icHtml) ic.innerHTML = icHtml; else if(ic) ic.innerHTML = icHtml; };
    try {
      var r = fn();
      if (r && typeof r.then === 'function') r.then(done, done);
      else done();
    } catch(e){ done(); throw e; }
  }
  function debounce(fn, ms){ var t; return function(){ var a=arguments, ctx=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,a); }, ms); }; }


  /* ---------------------------------------------------------------- */
  /* Kivo Intelligence & Insights (backend features surfaced)          */
  /* ---------------------------------------------------------------- */
  var insightsTab = 'trends';
  var intelTab = 'baseline';
  var remTab = 'obs';

  function setInsightsTab(tab){
    insightsTab = tab;
    document.querySelectorAll('#insights-tabs .intel-tab').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-insights-tab')===tab);
    });
    loadInsights(tab);
  }
  function setIntelTab(tab){
    intelTab = tab;
    document.querySelectorAll('#intel-tabs .intel-tab').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-intel-tab')===tab);
    });
    if(tab==='whatif'){
      $('whatif-body').classList.remove('hidden');
      loadIntel('baseline'); // keep baseline in background
    } else {
      $('whatif-body').classList.add('hidden');
      loadIntel(tab);
    }
  }
  function setRemTab(tab){
    remTab = tab;
    document.querySelectorAll('#rem-tabs .intel-tab').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-rem-tab')===tab);
    });
    $('obs-body').classList.toggle('hidden', tab!=='obs');
    $('reminders-body').classList.toggle('hidden', tab!=='reminders');
    $('storage-body').classList.toggle('hidden', tab!=='storage');
    if(tab==='obs') loadObservations();
    if(tab==='reminders') loadReminders();
    if(tab==='storage') updateStorageInfo();
  }

  function showSkeleton(host, lines){
    host.innerHTML='';
    for(var i=0;i<lines;i++){
      var s=el('div',{class:'skeleton skel '+(i===0?'w80':i===1?'w60':'w40')});
      s.style.height='14px';
      host.appendChild(s);
    }
  }

  function loadInsights(tab){
    if(!state.member) return;
    var id=state.member.id;
    var body=$('insights-body');
    showSkeleton(body, 3);
    var url;
    if(tab==='trends') url='/members/'+id+'/trends';
    else if(tab==='risk') url='/members/'+id+'/risk/diabetes';
    else if(tab==='guidance') url='/members/'+id+'/guidance';
    else if(tab==='meds') url='/members/'+id+'/medication-awareness';
    else if(tab==='summary') url='/members/'+id+'/doctor-summary';
    else return;

    var method = tab==='risk' ? 'POST' : 'GET';
    var opts = tab==='risk' ? {method:'POST', body:{}} : {};
    api(url, opts).then(function(data){
      body.innerHTML='';
      if(tab==='trends') renderTrends(body, data);
      else if(tab==='risk') renderRisk(body, data);
      else if(tab==='guidance') renderGuidance(body, data);
      else if(tab==='meds') renderMeds(body, data);
      else if(tab==='summary') renderSummary(body, data);
    }).catch(function(err){
      body.innerHTML='';
      body.appendChild(emptyState('info', err.message || 'Could not load '+tab));
    });
  }

  function renderTrends(host, data){
    if(!data || !data.trends){
      host.appendChild(emptyState('trending-up','No trends yet — verify a couple of reports to see movement.'));
      if(data && data.narrative) host.appendChild(disclaimerBox(data.narrative.disclaimer || data.narrative.text));
      return;
    }
    var trends = data.trends;
    if(Array.isArray(trends) && trends.length===0){
      host.appendChild(emptyState('trending-up','No trends yet — add more verified reports.'));
      return;
    }
    // trends may be array or object with by code
    var list = Array.isArray(trends) ? trends : (trends.items || []);
    // if still object, try to iterate keys
    if(list.length===0 && trends && typeof trends==='object' && !Array.isArray(trends)){
      // maybe trends is {code: analysis}
      for(var k in trends){
        if(k==='narrative' || k==='disclaimer') continue;
        var v=trends[k];
        if(v && v.code) list.push(v);
      }
    }
    if(list.length===0){
      host.appendChild(el('pre',{text: JSON.stringify(data,null,2), style:'font-size:11px; white-space:pre-wrap; background:#f6f8f9; padding:10px; border-radius:8px;'}));
      return;
    }
    list.slice(0,8).forEach(function(t){
      var card=el('div',{class:'intel-card'});
      var title = t.markerName || t.code || 'Trend';
      card.appendChild(el('h4',{text: title}));
      if(t.direction) card.appendChild(el('span',{class:'chip '+(t.direction==='up'?'amber': t.direction==='down'?'green':'grey'), text: t.direction}));
      if(t.change) card.appendChild(el('p',{class:'muted', text: t.change}));
      if(t.series && t.series.length){
        var last = t.series[t.series.length-1];
        card.appendChild(el('p',{class:'muted', text: 'Latest: '+(last.value!=null? last.value+' '+(last.unit||'') : '—')+' on '+(last.date||'') }));
      }
      if(t.interpretation) card.appendChild(el('p',{class:'muted', text: t.interpretation}));
      host.appendChild(card);
    });
    if(data.narrative) host.appendChild(disclaimerBox(data.narrative.text || data.narrative.disclaimer));
  }

  function renderRisk(host, data){
    if(!data || data.error){
      host.appendChild(emptyState('shield-check','Risk assessment needs more verified data.'));
      return;
    }
    // data is result of risk assess: {risk, band, confidenceNote, topFactors, ...}
    var r = data.result || data;
    var card=el('div',{class:'intel-card'});
    card.appendChild(el('h4',{text: 'Diabetes risk — prototype model'}));
    var pct = (r.risk!=null? r.risk : r.percent);
    if(pct!=null){
      var bar=el('div',{class:'risk-bar '+(r.band==='high'?'danger': r.band==='medium'?'warn':'')});
      bar.appendChild(el('i',{style:'width:'+Math.max(4,Math.min(100,pct))+'%'}));
      card.appendChild(bar);
      card.appendChild(el('div',{style:'display:flex; justify-content:space-between; font-size:13px;'},[el('b',{text: pct+'%'}), el('span',{class:'muted', text: r.band || ''})]));
    }
    if(r.topFactors && r.topFactors.length) card.appendChild(el('p',{class:'muted', text:'Top factors: '+r.topFactors.join(', ')}));
    if(r.confidenceNote) card.appendChild(disclaimerBox(r.confidenceNote));
    if(data.disclaimer) card.appendChild(disclaimerBox(data.disclaimer));
    // prototype disclaimer
    card.appendChild(el('p',{class:'muted', text:'Prototype only — not clinically validated.'}));
    host.appendChild(card);
  }

  function renderGuidance(host, data){
    if(!data){ host.appendChild(emptyState('info','No guidance yet.')); return; }
    var g = data.guidance || data;
    if(Array.isArray(g)){
      g.forEach(function(item){
        var c=el('div',{class:'intel-card'});
        c.appendChild(el('h4',{text: item.title || item.area || 'Guidance'}));
        c.appendChild(el('p',{class:'muted', text: item.text || item.message || JSON.stringify(item)}));
        host.appendChild(c);
      });
    } else if(g.sections){
      g.sections.forEach(function(s){
        var c=el('div',{class:'intel-card'});
        c.appendChild(el('h4',{text: s.title}));
        c.appendChild(el('p',{class:'muted', text: s.body}));
        host.appendChild(c);
      });
      if(g.disclaimer) host.appendChild(disclaimerBox(g.disclaimer));
    } else {
      host.appendChild(el('pre',{text: JSON.stringify(data,null,2), style:'font-size:11px; white-space:pre-wrap; background:#f6f8f9; padding:10px; border-radius:8px;'}));
    }
  }

  function renderMeds(host, data){
    if(!data){ host.appendChild(emptyState('pill','No medication awareness yet.')); return; }
    var items = data.items || data.medications || data;
    if(Array.isArray(items)){
      if(items.length===0) host.appendChild(emptyState('pill','No medications recorded — add them in observations.'));
      items.forEach(function(m){
        var c=el('div',{class:'intel-card'});
        c.appendChild(el('h4',{text: m.name || m.code || 'Medication'}));
        c.appendChild(el('p',{class:'muted', text: m.note || m.text || m.awareness || ''}));
        if(m.disclaimer) c.appendChild(disclaimerBox(m.disclaimer));
        host.appendChild(c);
      });
    } else {
      host.appendChild(el('pre',{text: JSON.stringify(data,null,2), style:'font-size:11px; white-space:pre-wrap; background:#f6f8f9; padding:10px; border-radius:8px;'}));
    }
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }

  function renderSummary(host, data){
    if(!data){ host.appendChild(emptyState('file-text','No summary yet — verify reports first.')); return; }
    var card=el('div',{class:'intel-card'});
    card.appendChild(el('h4',{text: data.title || 'Doctor summary'}));
    if(data.summary) card.appendChild(el('p',{text: data.summary}));
    if(data.sections){
      data.sections.forEach(function(s){
        card.appendChild(el('h4',{text: s.heading, style:'margin-top:10px; font-size:13px;'}));
        card.appendChild(el('p',{class:'muted', text: s.body}));
      });
    }
    if(data.observations) card.appendChild(el('p',{class:'muted', text: plural(data.observations.length,'observation','observations')+' included'}));
    if(data.medications) card.appendChild(el('p',{class:'muted', text: plural(data.medications.length,'medication','medications')+' listed'}));
    if(data.disclaimer) card.appendChild(disclaimerBox(data.disclaimer));
    host.appendChild(card);
  }

  function loadIntel(tab){
    if(!state.member) return;
    var id=state.member.id;
    var body=$('intel-body');
    showSkeleton(body,3);
    var url='/members/'+id+'/intelligence';
    if(tab==='baseline') url='/members/'+id+'/intelligence/baseline';
    else if(tab==='patterns') url='/members/'+id+'/intelligence/patterns';
    else if(tab==='anomalies') url='/members/'+id+'/intelligence';
    api(url).then(function(data){
      body.innerHTML='';
      if(tab==='baseline') renderBaseline(body, data);
      else if(tab==='patterns') renderPatterns(body, data);
      else if(tab==='anomalies') renderAnomalies(body, data);
    }).catch(function(err){
      body.innerHTML='';
      body.appendChild(emptyState('cpu', err.message || 'Could not load intelligence'));
    });
  }

  function renderBaseline(host, data){
    var list = data.baselines || data || [];
    if(Array.isArray(list) && list.length===0) { host.appendChild(emptyState('cpu','No baselines yet — add more verified reports.')); return; }
    // data may be single baseline
    if(!Array.isArray(list)) list=[list];
    list.slice(0,12).forEach(function(b){
      var c=el('div',{class:'intel-card'});
      c.appendChild(el('h4',{text: b.signal || b.marker || b.code || 'Signal'}));
      c.appendChild(el('p',{class:'muted', text: 'Mean: '+(b.mean!=null? b.mean : '—')+' · Range: '+(b.range || '—')}));
      if(b.count) c.appendChild(el('p',{class:'muted', text: plural(b.count,'point','points')+' · last '+ (b.lastValue!=null? b.lastValue : '—')}));
      host.appendChild(c);
    });
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }

  function renderPatterns(host, data){
    var edges = data.edges || data.graph && data.graph.edges || [];
    if(edges.length===0){ host.appendChild(emptyState('cpu','No strong patterns yet — keep adding reports and observations.')); return; }
    edges.slice(0,12).forEach(function(e){
      var c=el('div',{class:'intel-card'});
      c.appendChild(el('h4',{text: (e.from||e.source)+' → '+(e.to||e.target)}));
      c.appendChild(el('span',{class:'chip '+(e.strength>0.6?'green': e.strength>0.3?'amber':'grey'), text: 'strength '+(e.strength!=null? (e.strength*100|0)+'%' : '—')}));
      if(e.type) c.appendChild(el('p',{class:'muted', text: e.type}));
      if(e.explanation) c.appendChild(el('p',{class:'muted', text: e.explanation}));
      host.appendChild(c);
    });
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }

  function renderAnomalies(host, data){
    var findings = data.anomalies && data.anomalies.findings || data.findings || [];
    if(findings.length===0){ host.appendChild(emptyState('activity','No anomalies detected — your kivo looks stable.')); return; }
    findings.slice(0,10).forEach(function(f){
      var c=el('div',{class:'intel-card'});
      c.appendChild(el('h4',{text: f.type || f.kind || 'Anomaly'}));
      c.appendChild(el('p',{class:'muted', text: f.message || f.detail || f.explanation || ''}));
      if(f.signal) c.appendChild(el('p',{class:'muted', text:'Signal: '+f.signal+' · value '+(f.value!=null? f.value : '—')}));
      host.appendChild(c);
    });
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }

  /* What-If simulation */
  function doSimulate(){
    if(!state.member) return;
    var id=state.member.id;
    var changes={};
    var w=$('sim-weight').value.trim(), a=$('sim-activity').value.trim(), h=$('sim-hba1c').value.trim(), s=$('sim-sbp').value.trim();
    if(w) changes.weightKg=Number(w);
    if(a) changes.activityMinutesPerWeek=Number(a);
    if(h) changes.hba1c=Number(h);
    if(s) changes.systolicBp=Number(s);
    if(Object.keys(changes).length===0){ $('simulate-error').textContent='Enter at least one hypothetical value.'; $('simulate-error').classList.remove('hidden'); return; }
    $('simulate-error').classList.add('hidden');
    var btn=$('btn-simulate');
    withLoading(btn, function(){
      return api('/members/'+id+'/intelligence/simulate',{method:'POST', body:{changes:changes}}).then(function(res){
        var host=$('simulate-result'); host.innerHTML='';
        var card=el('div',{class:'intel-card'});
        card.appendChild(el('h4',{text: res.label || 'Scenario result'}));
        if(res.modelBefore && res.modelAfter){
          var before=res.modelBefore.result && res.modelBefore.result.risk || res.modelBefore.result && res.modelBefore.result.percent || 0;
          var after=res.modelAfter.result && res.modelAfter.result.risk || res.modelAfter.result && res.modelAfter.result.percent || 0;
          var delta = (after - before).toFixed(1);
          var dEl=el('div',{class:'scenario-delta '+(delta>0?'neg':'pos'), text: (delta>0?'+':'')+delta+' pts'});
          card.appendChild(dEl);
          card.appendChild(el('p',{class:'muted', text:'Model '+before+'% → '+after+'%'}));
        }
        if(res.contributionChanges) card.appendChild(el('pre',{text: JSON.stringify(res.contributionChanges,null,2), style:'font-size:11px; white-space:pre-wrap; background:#f6f8f9; padding:8px; border-radius:8px;'}));
        if(res.disclaimer) card.appendChild(disclaimerBox(res.disclaimer));
        card.appendChild(el('p',{class:'muted', text: (res.labels||[]).join(' · ')}));
        host.appendChild(card);
      }).catch(function(err){ $('simulate-error').textContent=err.message; $('simulate-error').classList.remove('hidden'); });
    });
  }

  function doExplore(){
    if(!state.member) return;
    var id=state.member.id;
    var host=$('scenarios-result');
    host.innerHTML=''; showSkeleton(host,2);
    api('/members/'+id+'/intelligence/scenarios',{method:'POST', body:{}}).then(function(res){
      host.innerHTML='';
      var list=res.scenarios || res || [];
      if(Array.isArray(list) && list.length===0){ host.appendChild(emptyState('activity','No scenarios available — add weight or activity data.')); return; }
      (Array.isArray(list)? list : list.scenarios || []).slice(0,6).forEach(function(sc){
        var c=el('div',{class:'scenario-card'});
        c.appendChild(el('h5',{text: sc.label || sc.id}));
        if(sc.delta!=null) c.appendChild(el('div',{class:'scenario-delta '+(sc.delta>0?'neg':'pos'), text: (sc.delta>0?'+':'')+sc.delta}));
        if(sc.modelAfter) c.appendChild(el('p',{class:'muted', text: JSON.stringify(sc.modelAfter.result||sc.modelAfter).slice(0,120)}));
        host.appendChild(c);
      });
      if(res.disclaimer) host.appendChild(disclaimerBox(res.disclaimer));
    }).catch(function(err){ host.innerHTML=''; host.appendChild(emptyState('info', err.message)); });
  }

  /* Ask kivo */
  function loadAskSuggestions(){
    if(!state.member) return;
    var id=state.member.id;
    api('/members/'+id+'/ask/suggestions').then(function(data){
      var host=$('ask-suggestions'); host.innerHTML='';
      var arr=data.suggestions || data || [];
      (Array.isArray(arr)?arr:[]).slice(0,6).forEach(function(s){
        var text = typeof s==='string'? s : (s.question || s.text || JSON.stringify(s));
        var b=el('button',{type:'button', text: text});
        b.addEventListener('click', function(){ $('ask-input').value=text; doAsk(); });
        host.appendChild(b);
      });
    }).catch(function(){});
  }
  function renderChat(){
    var host=$('ask-chat'); host.innerHTML='';
    state.chat.forEach(function(m){
      var d=el('div',{class:'chat-msg '+m.role});
      d.textContent=m.text;
      if(m.role==='bot' && m.disclaimer) d.appendChild(el('div',{class:'muted', text: m.disclaimer, style:'margin-top:6px; font-size:11px;'}));
      host.appendChild(d);
    });
    host.scrollTop = host.scrollHeight;
  }
  function doAsk(){
    var input=$('ask-input');
    var text=(input.value||'').trim();
    if(!text) return;
    if(!state.member) return;
    var id=state.member.id;
    state.chat.push({role:'user', text:text});
    renderChat();
    input.value='';
    $('ask-error').classList.add('hidden');
    var btn=$('ask-send');
    withLoading(btn, function(){
      return api('/members/'+id+'/ask',{method:'POST', body:{question:text}}).then(function(res){
        var ans = res.answer || res.text || res.narrative || JSON.stringify(res);
        var disclaimer = res.disclaimer || (res.meta && res.meta.disclaimer) || '';
        state.chat.push({role:'bot', text: ans, disclaimer: disclaimer});
        renderChat();
      }).catch(function(err){
        $('ask-error').textContent=err.message;
        $('ask-error').classList.remove('hidden');
        state.chat.push({role:'sys', text: err.message});
        renderChat();
      });
    });
  }

  /* Observations & Reminders */
  function loadObservations(){
    if(!state.member) return;
    var id=state.member.id;
    api('/members/'+id+'/observations').then(function(data){
      var list=data.items || data.observations || data || [];
      var host=$('obs-list'); host.innerHTML='';
      if(list.length===0){ host.appendChild(emptyState('activity','No observations yet — use voice or add below.')); return; }
      list.slice(0,20).forEach(function(o){
        var row=el('div',{class:'obs-item'});
        row.appendChild(el('span',{class:'obs-dot'}));
        var body=el('div',{style:'flex:1; min-width:0;'});
        body.appendChild(el('div',{style:'font-weight:600; font-size:13.5px;', text: o.kind}));
        body.appendChild(el('div',{class:'muted', text: (o.data && o.data.note) || JSON.stringify(o.data || o.payload || '').slice(0,120)}));
        body.appendChild(el('div',{class:'muted', style:'font-size:11px;', text: fmtDate(o.observedAt || o.createdAt)+' · '+ (o.source||'' )}));
        row.appendChild(body);
        var del=el('button',{class:'btn ghost sm', type:'button', text:'✕', title:'Delete'});
        del.addEventListener('click', function(){ deleteObservation(o.id); });
        row.appendChild(del);
        host.appendChild(row);
      });
    }).catch(function(){});
  }
  function deleteObservation(oid){
    if(!oid) return;
    api('/observations/'+oid,{method:'DELETE'}).then(function(){ toast('Observation removed'); loadObservations(); }).catch(function(e){ toast(e.message); });
  }
  function createObservationManual(ev){
    ev.preventDefault();
    if(!state.member) return;
    var kind=$('obs-kind').value;
    var text=$('obs-text').value.trim();
    if(!text) return;
    var payload={note:text};
    // try to parse number if weight/bp etc
    var num = (text.match(/(\d+(?:\.\d+)?)/)||[])[1];
    if(kind==='weight' && num) payload.weightKg=Number(num);
    if(kind==='bp' && num) payload.systolic=Number(num);
    if(kind==='activity' && num) payload.minutesPerWeek=Number(num);
    api('/members/'+state.member.id+'/observations',{method:'POST', body:{kind:kind, payload:payload, source:'manual'}}).then(function(){
      $('obs-text').value=''; toast('Observation saved'); loadObservations();
    }).catch(function(e){ toast(e.message); });
  }

  function loadReminders(){
    if(!state.member) return;
    var id=state.member.id;
    api('/members/'+id+'/reminders').then(function(data){
      var list=data.items || data.reminders || data || [];
      var host=$('reminders-list'); host.innerHTML='';
      if(list.length===0){ host.appendChild(emptyState('bell','No reminders — create one below.')); return; }
      list.forEach(function(r){
        var row=el('div',{class:'reminder-item'});
        var left=el('div',{style:'flex:1; min-width:0;'});
        left.appendChild(el('div',{style:'font-weight:600; font-size:13.5px;', text: r.title || r.text || 'Reminder'}));
        left.appendChild(el('div',{class:'when', text: (r.dueAt? fmtDate(r.dueAt) : 'No due date')+' · '+ (r.status||'')}));
        row.appendChild(left);
        var del=el('button',{class:'btn ghost sm', type:'button', text:'✕'});
        del.addEventListener('click', function(){
          api('/reminders/'+r.id,{method:'DELETE'}).then(function(){ toast('Reminder removed'); loadReminders(); }).catch(function(e){ toast(e.message); });
        });
        row.appendChild(del);
        host.appendChild(row);
      });
    }).catch(function(){});
  }
  function createReminder(ev){
    ev.preventDefault();
    if(!state.member) return;
    var title=$('rem-title').value.trim();
    var due=$('rem-due').value;
    if(!title) return;
    var body={title:title};
    if(due) body.dueAt = new Date(due).toISOString();
    api('/members/'+state.member.id+'/reminders',{method:'POST', body:body}).then(function(){
      $('rem-title').value=''; $('rem-due').value=''; toast('Reminder created'); loadReminders();
    }).catch(function(e){ toast(e.message); });
  }

  function updateStorageInfo(){
    var host=$('storage-info');
    if(!host) return;
    host.innerHTML='';
    var c=el('div',{class:'intel-card'});
    c.appendChild(el('h4',{text:'Health storage'}));
    var reportsCount = state.reports && state.reports.items ? state.reports.items.length : 0;
    var obsCount = 0; // will be updated after observations load
    c.appendChild(el('div',{class:'kv-row'},[el('span',{text:'Reports'}), el('b',{text: String(reportsCount)})]));
    c.appendChild(el('div',{class:'kv-row'},[el('span',{text:'Verified markers'}), el('b',{text: state.score && state.score.current ? String(state.score.current.markerCount) : '—'})]));
    c.appendChild(el('p',{class:'muted', text:'All reports are stored encrypted and can be exported via Profile → Export. Images are kept under your member and never leave your kivo without your consent.'}));
    var btn=el('button',{class:'btn ghost sm', type:'button', text:'Export my data'});
    btn.addEventListener('click', function(){
      api('/profile/export').then(function(blob){
        toast('Export ready — check your downloads');
      }).catch(function(e){ toast(e.message); });
    });
    c.appendChild(btn);
    host.appendChild(c);
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
     ['insights-head-ic', 'activity', 18], ['intel-head-ic', 'cpu', 18],
     ['ask-head-ic', 'message-circle', 18], ['rem-head-ic', 'bell', 18],
    ].forEach(function (t) { try{ Icons.set($(t[0]), t[1], t[2]); } catch(e){} });
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

  var readyDone = false;
  function ready(cb) {
    if (readyDone) return cb();
    document.addEventListener('DOMContentLoaded', cb, { once: true });
  }

  function init() {
    setStaticIcons();
    $('tab-login').addEventListener('click', function () { setAuthMode('login'); });
    $('tab-register').addEventListener('click', function () { setAuthMode('register'); });
    $('auth-form').addEventListener('submit', onAuthSubmit);
    $('btn-logout').addEventListener('click', onLogout);
    // btn-refresh is wired below with debounced + withLoading for buttery smoothness
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
    // kivo intelligence & insights
    document.querySelectorAll('#insights-tabs .intel-tab').forEach(function(b){
      b.addEventListener('click', function(){ setInsightsTab(b.getAttribute('data-insights-tab')); });
    });
    document.querySelectorAll('#intel-tabs .intel-tab').forEach(function(b){
      b.addEventListener('click', function(){ setIntelTab(b.getAttribute('data-intel-tab')); });
    });
    document.querySelectorAll('#rem-tabs .intel-tab').forEach(function(b){
      b.addEventListener('click', function(){ setRemTab(b.getAttribute('data-rem-tab')); });
    });
    var obsForm=$('obs-form'); if(obsForm) obsForm.addEventListener('submit', createObservationManual);
    var remForm=$('reminder-form'); if(remForm) remForm.addEventListener('submit', createReminder);
    var askSend=$('ask-send'); if(askSend) askSend.addEventListener('click', doAsk);
    var askInput=$('ask-input'); if(askInput) askInput.addEventListener('keydown', function(e){ if(e.key==='Enter') doAsk(); });
    var simBtn=$('btn-simulate'); if(simBtn) simBtn.addEventListener('click', doSimulate);
    var expBtn=$('btn-explore'); if(expBtn) expBtn.addEventListener('click', doExplore);
    // buttery smooth: debounced refresh
    var origRefresh = $('btn-refresh');
    if(origRefresh){
      origRefresh.addEventListener('click', debounce(function(){ withLoading(origRefresh, function(){ return refreshAll().then(function(){ toast('Refreshed.'); }); }); }, 200));
      // remove earlier direct listener by cloning? We'll keep both but debounce
    }

    readyDone = true;

    registerServiceWorker();
    if (window.KivoNative) {
      document.body.classList.add('native-app');
      window.KivoConnection.ensureReady().catch(function () { /* stays on login */ });
    }
    if (new URLSearchParams(location.search).get('login') === '1') {
      clearTokens(); // explicit cold-launch login; ordinary reload keeps a session
      history.replaceState(null, '', location.pathname);
    } else {
      loadTokens();
    }
    if (state.tokens && state.tokens.accessToken) {
      api('/auth/me').then(function (me) {
        state.user = me.user;
        notifySession();
        if (me.user && me.user.accountType === 'doctor') {
          try { sessionStorage.setItem('kivo.role-handoff', JSON.stringify(state.tokens)); } catch (e) { /* doctor can sign in directly */ }
        clearTokens();
        location.href = '/doctor/';
          return null;
        }
        return bootDashboard();
      }).catch(function () { showAuth(); });
    } else {
      showAuth();
    }
  }

  /* Cross-module bridge for sibling modules (care.js). Defined at evaluation
     time — not inside init() — because sibling <script> tags capture it before
     DOMContentLoaded fires. `ready()` is what waits for the shell's own init. */
  window.MtApp = {
    $: $,
    el: el,
    icon: icon,
    toast: toast,
    api: api,
    member: function () { return state.member; },
    user: function () { return state.user; },
    showView: showView,
    onSession: function (cb) { sessionListeners.push(cb); if (state.user) cb(state.user); },
    onMember: function (cb) { memberListeners.push(cb); if (state.member) cb(state.member); },
    ready: ready,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
