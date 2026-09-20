/**
 * kivo — kivoux.js · "Obsidian Vital" experience layer (2026 redesign)
 *
 * Sits on top of app.js (MtApp) + care.js without touching their logic:
 *   · splash → first light
 *   · page router (home / vitals / ask / profile) + care/report sync
 *   · hero greeting + quick actions
 *   · personalization onboarding (age, gender, height, weight, activity, goal, sleep)
 *   · animated AI-robot welcome
 *   · profile page renderer
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Icons = window.MtIcons;
  var App = window.MtApp;
  var Motion = window.KivoMotion;

  var PROFILE_KEY = 'kivo.profile.v1';
  var SEEN_BOT_KEY = 'kivo.bot.v1';

  /* ------------------------------------------------------------------ store */

  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveProfile(p) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ icons */

  function setIcon(idOrEl, name, size) {
    var el = typeof idOrEl === 'string' ? $(idOrEl) : idOrEl;
    if (el) Icons.set(el, name, size || 20);
  }

  function paintStaticIcons() {
    document.querySelectorAll('.nav-ic[data-ic]').forEach(function (n) { Icons.set(n, n.getAttribute('data-ic'), 22); });
    document.querySelectorAll('.qa-ic[data-ic]').forEach(function (n) { Icons.set(n, n.getAttribute('data-ic'), 20); });
    setIcon('score-head-ic', 'activity', 19);
    setIcon('mile-head-ic', 'trophy', 19);
    setIcon('rep-head-ic', 'file-text', 19);
    setIcon('insights-head-ic', 'trending-up', 19);
    setIcon('intel-head-ic', 'cpu', 19);
    setIcon('rem-head-ic', 'bell', 19);
    setIcon('ask-head-ic', 'sparkles', 19);
    setIcon('voice-head-ic', 'mic', 18);
    setIcon('hero-scan-ic', 'scan-line', 17);
    setIcon('hero-ask-ic', 'message-circle', 17);
    setIcon('ask-send-ic', 'send', 17);
    setIcon('scan-capture', 'camera', 24);
    setIcon('scan-icon', 'scan-line', 17);
    setIcon('upload-icon', 'upload', 15);
    setIcon('voice-icon', 'mic', 16);
    setIcon('logout-icon', 'log-out', 14);
    var apk = $('topbar-apk'); if (apk) Icons.set(apk, 'file-up', 18);
    setIcon('refresh-icon', 'refresh-cw', 15);
  }

  /* ------------------------------------------------------------------ splash */

  var splashGone = false;
  function killSplash() {
    if (splashGone) return;
    splashGone = true;
    var s = $('splash');
    if (s) {
      s.classList.add('gone');
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 700);
    }
  }

  /* ------------------------------------------------------------------ router */

  var PAGES = ['home', 'insights', 'ask', 'profile'];
  var currentPage = 'home';

  function showPage(name, opts) {
    if (PAGES.indexOf(name) < 0) name = 'home';
    currentPage = name;
    // a tab page always replaces the Care surface — no stacked views
    var cv = $('care-view');
    if (cv && !cv.classList.contains('hidden') && App && App.showView) App.showView('dash');
    PAGES.forEach(function (p) {
      var el = $('page-' + p);
      if (el) el.classList.toggle('hidden', p !== name);
    });
    document.querySelectorAll('.bottom-nav .nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-page') === name);
    });
    if (!opts || !opts.keepScroll) scrollTo(0, 0);
    var page = $('page-' + name);
    if (page && (!opts || !opts.noAnim)) {
      page.classList.remove('page-enter');
      void page.offsetWidth;
      page.classList.add('page-enter');
    }
    if (name === 'profile') renderProfile();
  }

  function activeView() {
    if ($('care-view') && !$('care-view').classList.contains('hidden')) return 'care';
    if ($('dash-view') && !$('dash-view').classList.contains('hidden')) return 'dash';
    return 'auth';
  }

  function syncChrome() {
    var view = activeView();
    document.body.classList.toggle('at-auth', view === 'auth');
    document.body.classList.toggle('in-app', view !== 'auth');
    if (view === 'dash') showPage(currentPage, { noAnim: true, keepScroll: true });
  }

  function bindNav() {
    var navInsights = $('nav-insights'), navAsk = $('nav-ask'), navHome = $('nav-home');
    if (navHome) navHome.addEventListener('click', function () { showPage('home'); });
    if (navInsights) navInsights.addEventListener('click', function () { showPage('insights'); });
    if (navAsk) navAsk.addEventListener('click', function () { showPage('ask'); });
    var avatar = $('topbar-avatar');
    if (avatar) avatar.addEventListener('click', function () { showPage('profile'); });
    ['care-view', 'dash-view', 'auth-view'].forEach(function (id) {
      var el = $(id);
      if (!el || !window.MutationObserver) return;
      new MutationObserver(syncChrome).observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    var careView = $('care-view');
    if (careView && window.MutationObserver) {
      new MutationObserver(function () { setTimeout(decorateCare, 40); }).observe(careView, { childList: true, subtree: false });
    }
  }

  /* ------------------------------------------------------------------ hero */

  function greetWord() {
    var h = new Date().getHours();
    if (h < 5) return 'Still up';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  var displayName = '';
  function onMemberName(member) {
    var name = '';
    if (member && member.displayName) name = String(member.displayName).trim().split(' ')[0];
    else {
      var p = loadProfile();
      if (p && p.name) name = p.name;
    }
    displayName = name || '';
    var hn = $('hero-name');
    if (hn) {
      hn.innerHTML = '';
      if (displayName) {
        hn.appendChild(document.createTextNode(greetWord() + ', '));
        var em = document.createElement('em');
        em.textContent = displayName;
        hn.appendChild(em);
        hn.appendChild(document.createTextNode('.'));
      } else {
        hn.appendChild(document.createTextNode('Your body, '));
        var em2 = document.createElement('em');
        em2.textContent = 'alive';
        hn.appendChild(em2);
        hn.appendChild(document.createTextNode('.'));
      }
    }
    var hg = $('hero-greet');
    if (hg && displayName) hg.textContent = greetWord();
  }

  function bindHeroAndQA() {
    var hs = $('hero-scan');
    if (hs) hs.addEventListener('click', function () { var b = $('btn-scan'); if (b) b.click(); });
    var ha = $('hero-ask');
    if (ha) ha.addEventListener('click', function () { showPage('ask'); });
    var qaVoice = $('qa-voice');
    if (qaVoice) qaVoice.addEventListener('click', function () { var b = $('btn-voice'); if (b) b.click(); });
    var qaMiles = $('qa-milestones');
    if (qaMiles) qaMiles.addEventListener('click', function () {
      showPage('home', { noAnim: true });
      var r = document.querySelector('.widget-miles');
      if (r) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    var qaVitals = $('qa-insights');
    if (qaVitals) qaVitals.addEventListener('click', function () { showPage('insights'); });
  }

  /* ------------------------------------------------------------------ robot */

  function robotSVG() {
    return '<svg class="bot-svg" viewBox="0 0 220 220" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="kivo robot">' +
      '<defs>' +
      '<linearGradient id="botBody" x1="60" y1="40" x2="160" y2="200" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#3A4A7E"/><stop offset="1" stop-color="#1B2550"/></linearGradient>' +
      '<linearGradient id="botFace" x1="70" y1="70" x2="150" y2="140" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4EDFF"/></linearGradient>' +
      '<linearGradient id="botAcc" x1="0" y1="0" x2="220" y2="220" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#4E9AF5"/><stop offset="1" stop-color="#8B7CF6"/></linearGradient>' +
      '</defs>' +
      '<ellipse cx="110" cy="204" rx="52" ry="8" fill="rgba(123,108,246,.16)"/>' +
      '<line x1="110" y1="18" x2="110" y2="38" stroke="url(#botAcc)" stroke-width="4" stroke-linecap="round"/>' +
      '<circle class="bot-antenna-dot" cx="110" cy="14" r="7" fill="#7B6CF6"/>' +
      '<circle cx="110" cy="14" r="12" stroke="rgba(123,108,246,.35)" stroke-width="2"/>' +
      '<rect x="55" y="38" width="110" height="112" rx="34" fill="url(#botBody)" stroke="rgba(255,255,255,.7)" stroke-width="1.5"/>' +
      '<rect x="72" y="58" width="76" height="56" rx="22" fill="url(#botFace)" stroke="rgba(123,108,246,.4)" stroke-width="1.5"/>' +
      '<g class="bot-eye" style="transform-origin:97px 86px"><circle cx="97" cy="86" r="7.5" fill="#5563EA"/></g>' +
      '<g class="bot-eye" style="transform-origin:123px 86px"><circle cx="123" cy="86" r="7.5" fill="#5563EA"/></g>' +
      '<path d="M100 100 Q110 108 120 100" stroke="#5563EA" stroke-width="3.5" stroke-linecap="round"/>' +
      '<rect x="88" y="128" width="44" height="8" rx="4" fill="rgba(255,255,255,.28)"/>' +
      '<path class="bot-arm" d="M55 92 Q30 96 26 118" stroke="url(#botAcc)" stroke-width="9" stroke-linecap="round"/>' +
      '<circle cx="26" cy="118" r="7" fill="#7B6CF6"/>' +
      '<path d="M165 92 Q188 96 192 112" stroke="url(#botAcc)" stroke-width="9" stroke-linecap="round"/>' +
      '<circle cx="192" cy="112" r="7" fill="#7B6CF6"/>' +
      '<path d="M78 150 L70 186" stroke="url(#botAcc)" stroke-width="9" stroke-linecap="round"/>' +
      '<path d="M142 150 L150 186" stroke="url(#botAcc)" stroke-width="9" stroke-linecap="round"/>' +
      '<path d="M60 186 L80 186" stroke="rgba(15,27,61,.25)" stroke-width="9" stroke-linecap="round"/>' +
      '<path d="M140 186 L160 186" stroke="rgba(15,27,61,.25)" stroke-width="9" stroke-linecap="round"/>' +
      '</svg>';
  }

  var botTimer = null;
  function playBot(lines, onDone) {
    var old = $('bot-welcome');
    if (old) old.parentNode.removeChild(old);

    var wrap = document.createElement('div');
    wrap.id = 'bot-welcome';
    wrap.innerHTML =
      '<div class="bot-glow"></div>' +
      '<div class="bot-stage">' + robotSVG() +
      '<div class="bot-bubble" id="bot-bubble"></div>' +
      '<button class="btn primary bot-cta hidden" id="bot-cta" type="button">Let’s go</button>' +
      '</div>';
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';

    var bubble = wrap.querySelector('#bot-bubble');
    var cta = wrap.querySelector('#bot-cta');
    var li = 0, ci = 0, dead = false;

    function type() {
      if (dead) return;
      if (li >= lines.length) {
        if (cta) cta.classList.remove('hidden');
        return;
      }
      var line = lines[li];
      if (ci < line.length) {
        if (line.charAt(ci) === '<') {
          var gt = line.indexOf('>', ci);
          ci = gt === -1 ? line.length : gt + 1;   // tags appear whole, never cut
        } else {
          var lt = line.indexOf('<', ci);
          var stop = lt === -1 ? line.length : lt;
          ci = stop - ci > 2 ? ci + 2 : stop;      // 2 chars per tick
        }
        bubble.innerHTML = line.slice(0, ci);
        botTimer = setTimeout(type, ci >= line.length ? 60 : 22);
      } else {
        li += 1; ci = 0;
        botTimer = setTimeout(type, 850);
      }
    }
    type();

    function close() {
      dead = true;
      if (botTimer) clearTimeout(botTimer);
      wrap.style.transition = 'opacity .4s ease';
      wrap.style.opacity = '0';
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        document.body.style.overflow = '';
        if (onDone) onDone();
      }, 420);
    }
    cta.addEventListener('click', close);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
  }

  function botLinesFor(profile, isNew) {
    var name = (profile && profile.name) || displayName || '';
    var n = name ? '<b>' + escapeHTML(name) + '</b>' : 'friend';
    if (isNew) {
      return [
        'Systems online. I am <b>K</b> — your digital health twin. 🤖',
        'I just tuned myself to ' + n + ': ' + profileSummary(profile) + '.',
        'Point me at a lab report and I will decode every line. Let’s grow your twin. ✦'
      ];
    }
    return [
      'Welcome back, ' + n + '. Your twin kept everything safe. ✦',
      'Ask me anything about your trends — I only speak from your verified data.'
    ];
  }

  function profileSummary(p) {
    if (!p) return 'personalized';
    var bits = [];
    if (p.age) bits.push(p.age + ' yrs');
    if (p.heightCm && p.weightKg) bits.push(p.heightCm + ' cm · ' + p.weightKg + ' kg');
    if (p.goal) bits.push(String(p.goal).replace(/-/g, ' '));
    return bits.length ? bits.join(', ') : 'personalized';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------ onboarding */

  var ACTIVITY = [
    { id: 'sedentary', label: 'Mostly resting', sub: 'Desk-bound, light walking', ic: 'info' },
    { id: 'light', label: 'Lightly active', sub: 'Walks · 1–2 light days a week', ic: 'activity' },
    { id: 'active', label: 'Active', sub: '3–5 workouts or brisk walks a week', ic: 'trending-up' },
    { id: 'athlete', label: 'Very active', sub: 'Training most days', ic: 'trophy' }
  ];
  var GOALS = [
    { id: 'prevent', label: 'Stay ahead of illness', sub: 'Early warnings, steady basics', ic: 'shield-check' },
    { id: 'energy', label: 'More energy', sub: 'Sleep, stamina, daily vibe', ic: 'sparkles' },
    { id: 'weight', label: 'Healthy weight', sub: 'Sustainable, tracked progress', ic: 'activity' },
    { id: 'numbers', label: 'Fix my numbers', sub: 'Sugar, BP, cholesterol focus', ic: 'pulse' }
  ];

  function onboardingOpen() {
    var p = loadProfile();
    var user = App && App.user ? App.user() : null;
    return !p && !!user;
  }

  function openOnboarding(onDone) {
    var user = App && App.user ? App.user() : null;
    var guessName = user && user.displayName ? user.displayName.split(' ')[0] : '';
    var st = { step: 0, name: guessName, age: 58, gender: '', heightCm: 168, weightKg: 70, activity: '', goal: '', sleepH: 7 };

    var root = document.createElement('div');
    root.id = 'onboarding';
    root.innerHTML =
      '<div class="ob-top">' +
      '<button class="ob-back" id="ob-back" type="button" aria-label="Back"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>' +
      '<div class="ob-progress"><i id="ob-bar"></i></div>' +
      '<span class="ob-step" id="ob-stepnum">1 / 5</span>' +
      '</div>' +
      '<div class="ob-body"><div id="ob-pane"></div>' +
      '<div class="ob-continue"><button class="btn primary block" id="ob-next" type="button">Continue</button>' +
      '<button class="ob-skip" id="ob-skip" type="button">Skip for now — I’ll add this later</button></div>' +
      '</div>';
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    var pane = root.querySelector('#ob-pane');
    var bar = root.querySelector('#ob-bar');
    var stepnum = root.querySelector('#ob-stepnum');
    var nextBtn = root.querySelector('#ob-next');
    var backBtn = root.querySelector('#ob-back');
    var skipBtn = root.querySelector('#ob-skip');

    function range(k, min, max, step, unit) {
      return '<input type="range" id="ob-' + k + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + st[k] + '" />' +
        '<output id="ob-' + k + '-out">' + st[k] + ' ' + unit + '</output>';
    }

    var PANES = [
      {
        kicker: 'About you', title: 'First — who is <em>kivo</em> for?', sub: 'Your twin shapes every insight around this.',
        valid: function () { return st.name.trim().length > 0 && st.age >= 5 && !!st.gender; },
        html: function () {
          return '<div class="ob-pane">' +
            '<label class="field"><span>Your name</span><input id="ob-name" type="text" placeholder="e.g. Arjun" value="' + escapeHTML(st.name) + '" autocomplete="name" /></label>' +
            '<label class="field" style="margin-top:14px"><span>Age — <b id="ob-age-out" style="color:var(--mint)">' + st.age + '</b> years</span>' +
            '<input type="range" id="ob-age" min="10" max="95" step="1" value="' + st.age + '" /></label>' +
            '<div class="ob-field" style="margin-top:16px"><label>Gender</label><div class="ob-seg">' +
            ['Male', 'Female', 'Other'].map(function (g) {
              return '<button type="button" class="ob-opt' + (st.gender === g.toLowerCase() ? ' sel' : '') + '" data-gender="' + g.toLowerCase() + '">' + g + '</button>';
            }).join('') + '</div></div>' +
            '</div>';
        },
        bind: function () {
          var nameIn = pane.querySelector('#ob-name');
          nameIn.addEventListener('input', function () { st.name = nameIn.value; validate(); });
          var ageIn = pane.querySelector('#ob-age');
          paint(ageIn);
          ageIn.addEventListener('input', function () {
            st.age = +ageIn.value;
            pane.querySelector('#ob-age-out').textContent = st.age;
            paint(ageIn);
          });
          pane.querySelectorAll('[data-gender]').forEach(function (b) {
            b.addEventListener('click', function () {
              st.gender = b.getAttribute('data-gender');
              pane.querySelectorAll('[data-gender]').forEach(function (x) { x.classList.toggle('sel', x === b); });
              validate();
            });
          });
        }
      },
      {
        kicker: 'Body basics', title: 'Height &amp; <em>weight</em>', sub: 'Two numbers that power your BMI and trends.',
        valid: function () { return true; },
        html: function () {
          return '<div class="ob-pane">' +
            '<div class="ob-field"><label>Height</label>' + range('heightCm', 120, 210, 1, 'cm') + '</div>' +
            '<div class="ob-field" style="margin-top:26px"><label>Weight</label>' + range('weightKg', 30, 160, 0.5, 'kg') + '</div>' +
            '<p class="muted" style="text-align:center;margin-top:22px" id="ob-bmi"></p></div>';
        },
        bind: function () {
          ['heightCm', 'weightKg'].forEach(function (k) {
            var inp = pane.querySelector('#ob-' + k);
            paint(inp);
            inp.addEventListener('input', function () {
              st[k] = +inp.value;
              pane.querySelector('#ob-' + k + '-out').textContent = st[k] + (k === 'heightCm' ? ' cm' : ' kg');
              paint(inp); bmiLine();
            });
          });
          bmiLine();
        }
      },
      {
        kicker: 'Lifestyle', title: 'How active is a <em>normal</em> week?', sub: 'Be honest — kivo calibrates goals to this.',
        valid: function () { return !!st.activity; },
        html: function () {
          return '<div class="ob-pane"><div class="ob-options">' + ACTIVITY.map(function (a) {
            return '<button type="button" class="ob-opt' + (st.activity === a.id ? ' sel' : '') + '" data-act="' + a.id + '">' +
              '<span class="ob-ic">' + Icons.svg(a.ic, 20) + '</span><span>' + a.label + '<small>' + a.sub + '</small></span></button>';
          }).join('') + '</div></div>';
        },
        bind: function () {
          pane.querySelectorAll('[data-act]').forEach(function (b) {
            b.addEventListener('click', function () {
              st.activity = b.getAttribute('data-act');
              pane.querySelectorAll('[data-act]').forEach(function (x) { x.classList.toggle('sel', x === b); });
              validate();
            });
          });
        }
      },
      {
        kicker: 'Intention', title: 'What should the twin <em>watch</em> for you?', sub: 'You can change this anytime in Profile.',
        valid: function () { return !!st.goal; },
        html: function () {
          return '<div class="ob-pane"><div class="ob-options">' + GOALS.map(function (g) {
            return '<button type="button" class="ob-opt' + (st.goal === g.id ? ' sel' : '') + '" data-goal="' + g.id + '">' +
              '<span class="ob-ic">' + Icons.svg(g.ic, 20) + '</span><span>' + g.label + '<small>' + g.sub + '</small></span></button>';
          }).join('') + '</div></div>';
        },
        bind: function () {
          pane.querySelectorAll('[data-goal]').forEach(function (b) {
            b.addEventListener('click', function () {
              st.goal = b.getAttribute('data-goal');
              pane.querySelectorAll('[data-goal]').forEach(function (x) { x.classList.toggle('sel', x === b); });
              validate();
            });
          });
        }
      },
      {
        kicker: 'Recovery', title: 'How many hours do you <em>sleep</em>?', sub: 'Sleep is where your twin does half its thinking.',
        valid: function () { return true; },
        html: function () {
          return '<div class="ob-pane"><div class="ob-field"><label>Sleep per night</label>' + range('sleepH', 3, 12, 0.5, 'hrs') + '</div>' +
            '<p class="muted" style="text-align:center;margin-top:20px" id="ob-sleepnote"></p></div>';
        },
        bind: function () {
          var inp = pane.querySelector('#ob-sleepH');
          paint(inp);
          function note() {
            var v = st.sleepH;
            pane.querySelector('#ob-sleepnote').textContent =
              v < 6 ? 'Short sleeper — kivo will watch recovery closely.' :
              v <= 9 ? 'Solid zone. Your twin likes this.' : 'Long sleeper — let’s check quality too.';
          }
          inp.addEventListener('input', function () {
            st.sleepH = +inp.value;
            pane.querySelector('#ob-sleepH-out').textContent = st.sleepH + ' hrs';
            paint(inp); note();
          });
          note();
        }
      }
    ];

    function paint(inp) {
      var min = +inp.min, max = +inp.max;
      var pct = ((+inp.value - min) / (max - min)) * 100;
      inp.style.setProperty('--fill', pct + '%');
    }
    function bmiLine() {
      var el = pane.querySelector('#ob-bmi');
      if (!el) return;
      var b = bmi(st.heightCm, st.weightKg);
      el.innerHTML = 'BMI <b style="color:' + bmiTone(b).c + '">' + b.toFixed(1) + '</b> · ' + bmiTone(b).t;
    }
    function validate() {
      nextBtn.disabled = !PANES[st.step].valid();
    }

    function render() {
      var P = PANES[st.step];
      stepnum.textContent = (st.step + 1) + ' / ' + PANES.length;
      bar.style.width = ((st.step) / (PANES.length - 1)) * 100 + '%';
      pane.innerHTML = '<span class="ob-kicker">' + P.kicker + '</span>' +
        '<h2 class="ob-title">' + P.title + '</h2><p class="ob-sub">' + P.sub + '</p>' + P.html();
      P.bind();
      nextBtn.textContent = st.step === PANES.length - 1 ? 'Meet your twin ✦' : 'Continue';
      backBtn.style.visibility = st.step === 0 ? 'hidden' : 'visible';
      validate();
      if (Motion) Motion.animate(pane, [
        { opacity: 0, transform: 'translateY(16px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }

    nextBtn.addEventListener('click', function () {
      if (!PANES[st.step].valid()) return;
      if (st.step < PANES.length - 1) { st.step += 1; render(); }
      else {
        var p = {
          name: st.name.trim(), age: st.age, gender: st.gender,
          heightCm: st.heightCm, weightKg: st.weightKg,
          activity: st.activity, goal: st.goal, sleepH: st.sleepH,
          at: Date.now()
        };
        saveProfile(p);
        close(function () {
          playBot(botLinesFor(p, true));
        });
      }
    });
    backBtn.addEventListener('click', function () { if (st.step > 0) { st.step -= 1; render(); } });
    skipBtn.addEventListener('click', function () {
      close(function () { playBot(botLinesFor(null, false)); });
    });

    function close(after) {
      root.style.transition = 'opacity .35s ease';
      root.style.opacity = '0';
      setTimeout(function () {
        if (root.parentNode) root.parentNode.removeChild(root);
        document.body.style.overflow = '';
        after && after();
      }, 360);
    }

    render();
  }

  function bmi(hCm, kg) {
    if (!hCm || !kg) return 0;
    var m = hCm / 100;
    return kg / (m * m);
  }
  function bmiTone(b) {
    if (b < 18.5) return { t: 'underweight', c: 'var(--sky)' };
    if (b < 25) return { t: 'healthy range', c: 'var(--mint)' };
    if (b < 30) return { t: 'overweight', c: 'var(--gold)' };
    return { t: 'obese range', c: 'var(--rose)' };
  }

  /* ------------------------------------------------------------------ profile page */

  function renderProfile() {
    var host = $('profile-body');
    if (!host) return;
    var p = loadProfile();
    var user = App && App.user ? App.user() : null;
    var member = App && App.member ? App.member() : null;
    var name = (p && p.name) || (user && user.displayName) || (member && member.displayName) || 'kivo member';
    var email = user && user.email ? user.email : '';
    host.innerHTML = '';

    var hero = document.createElement('section');
    hero.className = 'card profile-hero';
    hero.innerHTML =
      '<img class="profile-avatar" src="./img/avatar-user.jpg" alt="Profile photo" />' +
      '<h3 class="profile-name">' + escapeHTML(name) + '</h3>' +
      '<p class="profile-email">' + escapeHTML(email) + '</p>' +
      '<div class="profile-chips">' +
      (p && p.age ? '<span class="chip teal">' + p.age + ' yrs</span>' : '') +
      (p && p.gender ? '<span class="chip">' + escapeHTML(p.gender) + '</span>' : '') +
      (member && member.createdAt ? '<span class="chip grey">twin active</span>' : '') +
      '</div>';
    host.appendChild(hero);

    if (p) {
      var b = bmi(p.heightCm, p.weightKg);
      var tone = bmiTone(b);
      var pct = Math.max(4, Math.min(96, ((b - 14) / (40 - 14)) * 100));
      var bodyCard = document.createElement('section');
      bodyCard.className = 'card widget';
      bodyCard.innerHTML =
        '<div class="widget-head"><span class="widget-ic ic-teal">' + Icons.svg('activity', 19) + '</span>' +
        '<div><h2>Body metrics</h2><p class="muted">from your personalization</p></div></div>' +
        '<div style="display:flex;align-items:baseline;gap:10px">' +
        '<span style="font:600 40px/1 var(--font);letter-spacing:-.04em;color:' + tone.c + '">' + b.toFixed(1) + '</span>' +
        '<span class="muted">BMI · ' + tone.t + '</span></div>' +
        '<div class="bmi-gauge"><i style="left:' + pct + '%"></i></div>' +
        '<div class="profile-grid" style="margin-top:14px">' +
        pfCell('activity', 'Height', p.heightCm, 'cm') +
        pfCell('activity', 'Weight', p.weightKg, 'kg') +
        pfCell('pulse', 'Activity', labelOf(ACTIVITY, p.activity), '') +
        pfCell('trophy', 'Goal', labelOf(GOALS, p.goal), '') +
        '</div>';
      host.appendChild(bodyCard);
    }

    var actions = document.createElement('section');
    actions.className = 'card widget';
    actions.innerHTML = '<div class="widget-head"><span class="widget-ic ic-indigo">' + Icons.svg('user', 19) + '</span>' +
      '<div><h2>Account</h2><p class="muted">everything under your control</p></div></div>';
    actions.appendChild(row('sparkles', 'Edit my answers', 'Redo personalization', function () { openOnboarding(playBot.bind(null, botLinesFor(loadProfile(), true))); }));
    actions.appendChild(row('refresh-cw', 'Refresh my data', 'Pull the latest from your twin', function () {
      var b = $('btn-refresh'); if (b) b.click();
    }));
    if (window.KivoNative) {
      actions.appendChild(row('info', 'Change server', window.KivoNative.apiBase ? safeHost() : '', function () { window.KivoNative.changeServer(); }));
    }
    actions.appendChild(row('file-up', 'Get the Android APK', '/download/apk', function () { location.href = '/download/apk'; }));
    actions.appendChild(row('log-out', 'Sign out', email, function () { var b = $('btn-logout'); if (b) b.click(); }));
    host.appendChild(actions);

    var note = document.createElement('p');
    note.className = 'muted';
    note.style.cssText = 'text-align:center;font-size:11px;padding:6px 14px 0';
    note.textContent = 'kivo is risk-awareness software — not a medical device. Always consult a qualified professional.';
    host.appendChild(note);

    function pfCell(ic, k, v, unit) {
      return '<div class="pf-cell"><span class="k">' + Icons.svg(ic, 13) + k + '</span>' +
        '<div class="v">' + escapeHTML(String(v == null ? '—' : v)) + (unit ? ' <small>' + unit + '</small>' : '') + '</div></div>';
    }
    function row(ic, title, sub, fn) {
      var r = document.createElement('button');
      r.type = 'button';
      r.className = 'link-row';
      r.style.width = '100%';
      r.innerHTML = '<span class="widget-ic" style="width:34px;height:34px;border-radius:11px;background:var(--mint-soft);color:var(--mint);flex:none">' + Icons.svg(ic, 16) + '</span>' +
        '<span style="flex:1;text-align:left">' + title + (sub ? '<small style="display:block;font-weight:500;color:var(--muted);font-size:11px">' + escapeHTML(sub) + '</small>' : '') + '</span>' +
        '<span style="color:var(--muted-2)">' + Icons.svg('chevron-right', 16) + '</span>';
      r.addEventListener('click', fn);
      return r;
    }
    function labelOf(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
      return id || '—';
    }
    function safeHost() {
      try { return new URL(window.KivoNative.apiBase() || location.origin).host; } catch (e) { return 'server'; }
    }
  }

  /* ------------------------------------------------------------------ care page photos */

  function decorateCare() {
    var view = $('care-view');
    if (!view || view.classList.contains('hidden')) return;
    if (!view.querySelector('.care-banner')) {
      var ban = document.createElement('div');
      ban.className = 'care-banner';
      ban.innerHTML = '<img src="./img/walk.jpg" alt="" />' +
        '<b>Care, in every sense — <em>doctors who see your twin.</em></b>';
      view.insertBefore(ban, view.firstChild);
    }
    var cards = view.querySelectorAll('.doctor-card');
    for (var i = 0; i < cards.length; i++) {
      var av = cards[i].querySelector('.avatar');
      if (av && !av.querySelector('img')) {
        var who = cards[i].querySelector('.doctor-who strong');
        var img = document.createElement('img');
        img.src = docPhotoFor(who ? who.textContent : '');
        img.alt = '';
        av.innerHTML = '';
        av.appendChild(img);
      }
    }
    // real photo posters for known shorts; the rest keep the dusk gradients
    var shorts = view.querySelectorAll('.short-card');
    for (var s = 0; s < shorts.length; s++) {
      var poster = shorts[s].querySelector('.short-poster');
      if (!poster || poster.querySelector('img')) continue;
      var t = shorts[s].querySelector('.short-title');
      var title = t ? t.textContent.toLowerCase() : '';
      var src = '';
      if (title.indexOf('knee') >= 0) src = './img/short-knee.jpg';
      else if (title.indexOf('sitting') >= 0 || title.indexOf('back') >= 0) src = './img/short-desk.jpg';
      if (src) {
        var pimg = document.createElement('img');
        pimg.src = src;
        pimg.alt = '';
        poster.insertBefore(pimg, poster.firstChild);
      }
    }
  }

  /* stable, human photo mapping for doctor cards */
  function docPhotoFor(name) {
    var n = String(name || '').toLowerCase();
    if (n.indexOf('mohan') >= 0) return './img/doc-3.jpg';
    if (n.indexOf('asha') >= 0 || n.indexOf('meera') >= 0) return './img/doc-1.jpg';
    var h = 0;
    for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return './img/' + ['doc-1', 'doc-2', 'doc-4'][h % 3] + '.jpg';
  }

  /* ------------------------------------------------------------------ session flow */

  var botPlayedThisSession = false;

  function afterAuth() {
    var tb = $('topbar-avatar');
    if (tb) tb.classList.remove('hidden');
    if (onboardingOpen()) {
      setTimeout(function () { openOnboarding(); }, 500);
    } else if (!botPlayedThisSession) {
      botPlayedThisSession = true;
      setTimeout(function () { playBot(botLinesFor(loadProfile(), false)); }, 500);
    }
  }

  function onSignOut() {
    var tb = $('topbar-avatar');
    if (tb) tb.classList.add('hidden');
    botPlayedThisSession = false;
    var ob = $('onboarding'); if (ob) ob.parentNode.removeChild(ob);
    var bw = $('bot-welcome'); if (bw) bw.parentNode.removeChild(bw);
    document.body.style.overflow = '';
    showPage('home', { noAnim: true });
  }

  /* ------------------------------------------------------------------ init */

  function injectAuthHero() {
    var auth = $('auth-view');
    if (!auth || !auth.parentNode || auth.parentNode.querySelector('.auth-hero')) return;
    var h = document.createElement('div');
    h.className = 'auth-hero';
    h.innerHTML = '<img src="./img/walk.jpg" alt="" />' +
      '<div class="auth-hero-shade"></div>' +
      '<div class="auth-hero-copy">' +
      '<span class="hero-greet">your body, alive</span>' +
      '<p>Scan it. Understand it. <b>Grow your twin.</b></p>' +
      '</div>';
    auth.parentNode.insertBefore(h, auth);
  }

  function init() {
    paintStaticIcons();
    bindNav();
    bindHeroAndQA();
    injectAuthHero();
    var sc = $('scan-close'); if (sc) Icons.set(sc.querySelector('.btn-ic'), 'x', 15);
    var sg = $('scan-gallery'); if (sg) Icons.set(sg.querySelector('.btn-ic'), 'upload', 15);

    // ranges need --fill even before first input
    document.querySelectorAll('input[type="range"]').forEach(paintFill);

    if (App) {
      App.onSession(function (user) {
        if (user) afterAuth();
        else onSignOut();
      });
      App.onMember(onMemberName);
    }

    // initial chrome state (auth or restored session)
    setTimeout(syncChrome, 60);
    setTimeout(killSplash, 1100);
  }

  function paintFill(inp) {
    var min = +inp.min, max = +inp.max;
    if (isNaN(min) || isNaN(max) || max === min) return;
    inp.style.setProperty('--fill', (((+inp.value - min) / (max - min)) * 100) + '%');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KivoUX = { showPage: showPage, playBot: playBot, openOnboarding: openOnboarding };
})();
