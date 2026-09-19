/* kivo — Care tab: subscription (demo checkout), doctor consults, shorts.
 *
 * Deliberately separate from app.js (the health-twin dashboard) so the twin
 * screens stay untouched while the care network grows. It borrows the shell's
 * api client / toasts / DOM helpers through window.MtApp and stays inside the
 * same CSP rules (external file, no inline handlers).
 */
(function () {
  'use strict';

  var App = window.MtApp;
  var Icons = window.MtIcons;
  var el = App.el;
  var icon = App.icon;
  var toast = App.toast;
  var api = App.api;

  var state = {
    loaded: false,
    entitlements: null,
    plans: [],
    billing: null,
    doctors: [],
    specialties: [],
    consultations: [],
    videos: [],
    videoTopics: [],
    access: null,
    topic: null,
    detail: null,
    doctorQuery: '',
  };

  var STATUS_TONE = {
    payment_pending: 'amber',
    requested: 'indigo',
    in_review: 'teal',
    answered: 'green',
    closed: 'grey',
    cancelled: 'red',
  };

  /* ---------------------------------------------------------------- helpers */

  function rs(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN');
  }

  function shortDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function statusChip(status) {
    return el('span', { class: 'chip ' + (STATUS_TONE[status] || 'grey'), text: String(status).replace(/_/g, ' ') });
  }

  // Demo-build disclosure. The chip stays honest about what this build does
  // NOT do (take money, check a medical registry) without leaking the
  // implementation behind it.
  function demoBadge(label) {
    return el('span', {
      class: 'chip demo',
      title: 'This build is a preview: no payment is taken and no medical registry is contacted.',
      text: label || 'DEMO',
    });
  }

  function sectionHead(iconName, title, sub) {
    var head = el('div', { class: 'care-head' });
    head.appendChild(icon(iconName, 20, 'care-head-ic'));
    var box = el('div');
    box.appendChild(el('h2', { text: title }));
    if (sub) box.appendChild(el('p', { class: 'muted', text: sub }));
    head.appendChild(box);
    return head;
  }

  function emptyState(iconName, text) {
    var box = el('div', { class: 'care-empty' });
    box.appendChild(icon(iconName, 26));
    box.appendChild(el('p', { class: 'muted', text: text }));
    return box;
  }

  /* ------------------------------------------------------------------ shell */

  function open() {
    App.showView('care');
    document.querySelectorAll('#bottom-nav .nav-item').forEach(function (b) {
      b.classList.toggle('active', b.id === 'nav-care');
    });
    if (!state.loaded) refresh();
    else render();
  }

  function close() {
    App.showView('dash');
    renderTeaser();
  }

  function refresh() {
    var view = App.$('care-view');
    view.innerHTML = '';
    view.appendChild(el('p', { class: 'muted', text: 'Loading your care network…' }));
    return Promise.all([
      api('/care/entitlements').catch(function () { return null; }),
      api('/care/plans').catch(function () { return null; }),
      api('/care/doctors?pageSize=24').catch(function () { return null; }),
      api('/care/consultations?pageSize=20').catch(function () { return null; }),
      api('/care/videos?pageSize=24').catch(function () { return null; }),
    ]).then(function (r) {
      state.entitlements = r[0] ? r[0].entitlements : null;
      state.plans = r[1] ? r[1].plans : [];
      state.billing = r[1] ? r[1].billing : null;
      state.doctors = r[2] ? r[2].items : [];
      state.specialties = r[2] ? r[2].specialties : [];
      state.consultations = r[3] ? r[3].items : [];
      state.videos = r[4] ? r[4].items : [];
      state.videoTopics = r[4] ? r[4].topics : [];
      state.access = r[4] ? r[4].access : null;
      state.loaded = true;
      render();
      renderTeaser();
    });
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    var view = App.$('care-view');
    view.innerHTML = '';
    view.appendChild(planCard());
    if (state.consultations.length > 0) view.appendChild(consultationsSection());
    view.appendChild(doctorsSection());
    view.appendChild(shortsSection());
    view.appendChild(el('footer', { class: 'foot' })).appendChild(
      el('p', {
        text:
          'Care+ is a preview of an assisted-care product: no payment is taken in this build, doctor profiles are ' +
          'not registry-checked yet, every reply is written by the doctor you chose, and drafted medicine suggestions ' +
          'are only ever shown to a doctor for review.',
      }),
    );
  }

  function planCard() {
    var ent = state.entitlements;
    var card = el('section', { class: 'card care-plan' });
    var head = el('div', { class: 'care-head' });
    head.appendChild(icon('sparkles', 20, 'care-head-ic'));
    var box = el('div');
    box.appendChild(el('h2', { id: 'care-h', text: 'kivo care+' }));
    box.appendChild(el('p', { class: 'muted', text: 'A doctor on your chart — no clinic queue for small doubts.' }));
    head.appendChild(box);
    card.appendChild(head);

    card.appendChild(
      el('div', { class: 'care-plan-row' }, [
        el('div', { class: 'care-plan-main' }, [
          el('strong', { text: ent && ent.active ? ent.plan.name : 'Free twin' }),
          el('span', {
            class: 'muted',
            text: ent && ent.active
              ? rs(ent.plan.priceInr) + ' / ' + ent.plan.interval + ' · renews ' + shortDate(ent.currentPeriodEnd)
              : 'Doctor consults and the full shorts library are locked',
          }),
        ]),
        ent && ent.active
          ? el('span', { class: 'chip green', text: (ent.consultationsRemaining || 0) + ' consults left' })
          : el('span', { class: 'chip grey', text: 'Preview only' }),
      ]),
    );

    var actions = el('div', { class: 'care-actions' });
    if (ent && ent.active) {
      var pick = el('button', { class: 'btn secondary sm', type: 'button' }, ['Change plan']);
      pick.addEventListener('click', openPlanSheet);
      actions.appendChild(pick);
      var cancel = el('button', { class: 'btn ghost sm', type: 'button' }, ['Cancel plan']);
      cancel.addEventListener('click', cancelPlan);
      actions.appendChild(cancel);
    } else {
      var upgrade = el('button', { class: 'btn primary sm', type: 'button' });
      upgrade.appendChild(icon('wallet', 16));
      upgrade.appendChild(document.createTextNode('See Care+ plans'));
      upgrade.addEventListener('click', openPlanSheet);
      actions.appendChild(upgrade);
    }
    var bill = el('button', { class: 'btn ghost sm', type: 'button' }, ['Payment history']);
    bill.addEventListener('click', openPaymentsSheet);
    actions.appendChild(bill);
    card.appendChild(actions);
    card.appendChild(demoBadge('Demo checkout — no card, UPI or bank details, no money moves'));
    return card;
  }

  function consultationsSection() {
    var section = el('section', { class: 'card care-section' });
    section.appendChild(sectionHead('message-square', 'Your consultations', 'Only you and the doctor you chose can read these.'));
    var list = el('div', { class: 'care-list' });
    state.consultations.forEach(function (c) {
      var row = el('div', { class: 'care-consult' });
      var left = el('div', { class: 'care-consult-main' });
      left.appendChild(el('strong', { text: c.subject }));
      left.appendChild(
        el('span', {
          class: 'muted',
          text: (c.doctor ? c.doctor.fullName + ' · ' + c.doctor.headline : 'Doctor') + ' · ' + shortDate(c.createdAt),
        }),
      );
      row.appendChild(left);
      var right = el('div', { class: 'care-consult-side' });
      right.appendChild(statusChip(c.status));
      if (c.needsPayment) right.appendChild(el('span', { class: 'chip amber', text: rs(c.feeInr) + ' due' }));
      right.appendChild(icon('chevron-right', 18));
      row.appendChild(right);
      row.addEventListener('click', function () { openConsultation(c.id); });
      list.appendChild(row);
    });
    section.appendChild(list);
    return section;
  }

  function doctorsSection() {
    var section = el('section', { class: 'card care-section' });
    section.appendChild(
      sectionHead('stethoscope', 'Find a doctor', 'Their chart, your data, one question at a time — no 10-question intake.'),
    );

    var bar = el('div', { class: 'care-search' });
    var input = el('input', { type: 'search', placeholder: 'Search name, problem or city', value: state.doctorQuery });
    input.addEventListener('input', function () { state.doctorQuery = input.value.trim(); renderDoctorList(list); });
    bar.appendChild(icon('search', 16));
    bar.appendChild(input);
    section.appendChild(bar);

    var chips = el('div', { class: 'chip-row' });
    var all = el('button', { class: 'chip-btn' + (state.specialtyFilter ? '' : ' active'), type: 'button' }, ['All']);
    all.addEventListener('click', function () { state.specialtyFilter = null; render(); });
    chips.appendChild(all);
    state.specialties
      .filter(function (s) { return s.doctors > 0; })
      .slice(0, 10)
      .forEach(function (s) {
        var b = el('button', { class: 'chip-btn' + (state.specialtyFilter === s.key ? ' active' : ''), type: 'button' }, [
          s.label + ' (' + s.doctors + ')',
        ]);
        b.addEventListener('click', function () { state.specialtyFilter = s.key; render(); });
        chips.appendChild(b);
      });
    section.appendChild(chips);

    var list = el('div', { class: 'care-list care-doctors' });
    renderDoctorList(list);
    section.appendChild(list);
    return section;
  }

  function renderDoctorList(host) {
    host.innerHTML = '';
    var q = state.doctorQuery.toLowerCase();
    var items = state.doctors.filter(function (d) {
      if (state.specialtyFilter && d.specialty !== state.specialtyFilter) return false;
      if (!q) return true;
      return (d.fullName + ' ' + d.headline + ' ' + (d.city || '')).toLowerCase().indexOf(q) >= 0;
    });
    if (items.length === 0) {
      host.appendChild(emptyState('users', 'No doctors match that yet.'));
      return;
    }
    items.forEach(function (d) {
      var card = el('div', { class: 'doctor-card' });
      var top = el('div', { class: 'doctor-top' });
      top.appendChild(el('span', { class: 'avatar', html: Icons.svg('stethoscope', 18) }));
      var who = el('div', { class: 'doctor-who' });
      who.appendChild(el('strong', { text: d.fullName }));
      who.appendChild(el('span', { class: 'muted', text: d.headline + (d.city ? ' · ' + d.city : '') }));
      who.appendChild(
        el('span', {
          class: 'doctor-meta',
          text:
            (d.experienceYears ? d.experienceYears + ' yrs · ' : '') +
            (d.consultCount ? d.consultCount + ' consults · ' : '') +
            d.videoCount + ' shorts',
        }),
      );
      top.appendChild(who);
      card.appendChild(top);
      var badges = el('div', { class: 'chip-row' });
      badges.appendChild(el('span', { class: 'chip teal', text: d.headline }));
      if (d.verified) {
        badges.appendChild(el('span', {
          class: 'chip green',
          text: 'Verified in this demo',
          title: 'Preview build — medical registries are not contacted yet.',
        }));
      }
      badges.appendChild(el('span', { class: 'chip grey', text: d.consultFeeInr ? rs(d.consultFeeInr) + ' / consult' : 'Free consult' }));
      card.appendChild(badges);
      var actions = el('div', { class: 'care-actions' });
      var book = el('button', { class: 'btn primary sm', type: 'button' });
      book.appendChild(icon('calendar-range', 16));
      book.appendChild(document.createTextNode('Ask this doctor'));
      book.addEventListener('click', function () { openBooking(d); });
      actions.appendChild(book);
      card.appendChild(actions);
      host.appendChild(card);
    });
  }

  function shortsSection() {
    var section = el('section', { class: 'card care-section' });
    section.appendChild(
      sectionHead('video', 'Doctor shorts', '45-second answers to the doubts that fill up clinic waiting rooms.'),
    );
    if (state.access && !state.access.fullAccess) {
      var upsell = el('div', { class: 'care-upsell' });
      upsell.appendChild(icon('lock', 16));
      upsell.appendChild(el('span', { text: state.access.upsell || 'Care+ unlocks the full library.' }));
      var up = el('button', { class: 'btn primary sm', type: 'button' }, ['Unlock']);
      up.addEventListener('click', openPlanSheet);
      upsell.appendChild(up);
      section.appendChild(upsell);
    }
    var chips = el('div', { class: 'chip-row' });
    var allChip = el('button', { class: 'chip-btn' + (state.topic ? '' : ' active'), type: 'button' }, ['All topics']);
    allChip.addEventListener('click', function () { state.topic = null; loadShorts(); });
    chips.appendChild(allChip);
    state.videoTopics.slice(0, 8).forEach(function (t) {
      var b = el('button', { class: 'chip-btn' + (state.topic === t.topic ? ' active' : ''), type: 'button' }, [
        t.label + ' (' + t.videos + ')',
      ]);
      b.addEventListener('click', function () { state.topic = t.topic; loadShorts(); });
      chips.appendChild(b);
    });
    section.appendChild(chips);

    var grid = el('div', { class: 'shorts-grid' });
    if (state.videos.length === 0) {
      grid.appendChild(emptyState('video', 'No shorts published yet — our first doctors are recording.'));
    }
    state.videos.forEach(function (v) {
      var card = el('button', { class: 'short-card' + (v.locked ? ' locked' : ''), type: 'button' });
      var poster = el('span', { class: 'short-poster', 'data-topic': v.topic });
      poster.appendChild(el('span', { class: 'short-dur', text: v.durationSec + 's' }));
      poster.appendChild(el('span', { class: 'short-play', html: Icons.svg(v.locked ? 'lock' : 'play', 20) }));
      if (v.isPreview) poster.appendChild(el('span', { class: 'short-free', text: 'FREE' }));
      card.appendChild(poster);
      card.appendChild(el('span', { class: 'short-title', text: v.title }));
      card.appendChild(
        el('span', { class: 'muted', text: (v.doctor ? v.doctor.fullName : 'Doctor') + ' · ' + (v.viewCount || 0) + ' views' }),
      );
      card.addEventListener('click', function () {
        if (v.locked) openPaywallSheet(v);
        else openPlayer(v.id);
      });
      grid.appendChild(card);
    });
    section.appendChild(grid);
    section.appendChild(
      el('p', {
        class: 'muted care-note',
        text: 'Watching shorts pays the doctor from the monthly pool (split by watched seconds) — reach, not clickbait.',
      }),
    );
    return section;
  }

  function renderTeaser() {
    var host = App.$('care-teaser');
    if (!host) return;
    host.innerHTML = '';
    var ent = state.entitlements;
    var card = el('section', { class: 'card care-teaser-card' });
    var left = el('div', { class: 'care-teaser-main' });
    left.appendChild(icon('stethoscope', 18, 'care-head-ic'));
    var txt = el('div');
    txt.appendChild(el('strong', { text: ent && ent.active ? 'Care+ active' : 'Talk to a doctor, without the queue' }));
    txt.appendChild(
      el('span', {
        class: 'muted',
        text: ent && ent.active
          ? (ent.consultationsRemaining || 0) + ' consultations left this month · full shorts library unlocked'
          : 'Ask one question, share only the chart sections you choose, watch 45s answers.',
      }),
    );
    left.appendChild(txt);
    card.appendChild(left);
    var go = el('button', { class: 'btn primary sm', type: 'button' }, [ent && ent.active ? 'Open Care+' : 'Explore Care+']);
    go.addEventListener('click', open);
    card.appendChild(go);
    host.appendChild(card);
  }

  /* ------------------------------------------------------------------ sheets */

  function sheet(title, { wide } = {}) {
    var overlay = el('div', { class: 'sheet-overlay' });
    var box = el('div', { class: 'sheet' + (wide ? ' sheet-wide' : '') });
    var head = el('div', { class: 'sheet-head' });
    head.appendChild(el('h3', { text: title }));
    var close = el('button', { class: 'btn ghost sm icon-btn', type: 'button', 'aria-label': 'Close' }, [
      el('span', { class: 'btn-ic', html: Icons.svg('x', 16) }),
    ]);
    close.addEventListener('click', function () { document.body.removeChild(overlay); });
    head.appendChild(close);
    box.appendChild(head);
    var body = el('div', { class: 'sheet-body' });
    box.appendChild(body);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
    document.body.appendChild(overlay);
    return { overlay: overlay, body: body, close: function () { if (overlay.parentNode) document.body.removeChild(overlay); } };
  }

  function openPlanSheet() {
    var s = sheet('Choose a Care+ plan', { wide: true });
    s.body.appendChild(
      el('p', {
        class: 'muted',
        text: 'Every plan keeps the free twin. Demo payments — no card, UPI ID or bank detail is ever collected.',
      }),
    );
    state.plans.forEach(function (plan) {
      var card = el('div', { class: 'plan-option' });
      var left = el('div');
      left.appendChild(el('strong', { text: plan.name }));
      left.appendChild(el('span', { class: 'muted', text: plan.tagline || '' }));
      var feats = el('ul', { class: 'plan-features' });
      (plan.features || []).forEach(function (f) { feats.appendChild(el('li', { text: f })); });
      left.appendChild(feats);
      card.appendChild(left);
      var right = el('div', { class: 'plan-side' });
      right.appendChild(el('strong', { text: plan.priceInr === 0 ? 'Free' : rs(plan.priceInr) }));
      right.appendChild(el('span', { class: 'muted', text: plan.priceInr === 0 ? '' : 'per ' + plan.interval }));
      var btn = el('button', { class: 'btn ' + (plan.priceInr === 0 ? 'ghost' : 'primary') + ' sm', type: 'button' }, [
        plan.priceInr === 0 ? 'Free tier' : 'Choose plan',
      ]);
      btn.disabled = plan.priceInr === 0 || (state.entitlements && state.entitlements.active && state.entitlements.plan.code === plan.code);
      btn.addEventListener('click', function () { s.close(); buyPlan(plan); });
      right.appendChild(btn);
      card.appendChild(right);
      s.body.appendChild(card);
    });
    s.body.appendChild(demoBadge('Demo checkout — no payment is taken'));
  }

  function openPaymentSheet({ title, amountInr, note, onSuccess, intentId }) {
    var s = sheet(title || 'Demo checkout');
    s.body.appendChild(el('p', { class: 'demo-line' }, [demoBadge('DEMO'), el('span', { text: ' No payment is taken — this step is recorded so the flow stays complete.' })]));
    s.body.appendChild(el('div', { class: 'pay-amount', text: rs(amountInr) }));
    if (note) s.body.appendChild(el('p', { class: 'muted', text: note }));

    var methods = el('div', { class: 'pay-methods' });
    var chosen = 'upi';
    ['upi', 'card', 'netbanking', 'wallet'].forEach(function (m, i) {
      var b = el('button', { class: 'chip-btn' + (i === 0 ? ' active' : ''), type: 'button' }, [m.toUpperCase()]);
      b.addEventListener('click', function () {
        chosen = m;
        methods.querySelectorAll('.chip-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      });
      methods.appendChild(b);
    });
    s.body.appendChild(methods);

    var err = el('p', { class: 'error hidden' });
    var pay = el('button', { class: 'btn primary block', type: 'button' }, ['Confirm ' + rs(amountInr) + ' — demo checkout']);
    pay.addEventListener('click', function () {
      pay.disabled = true;
      api('/care/payments/' + intentId + '/confirm', { method: 'POST', body: { method: chosen, simulate: 'success' } })
        .then(function (res) {
          s.close();
          toast('Demo checkout complete — no money moved.');
          onSuccess(res);
        })
        .catch(function (e) {
          err.textContent = e.message;
          err.classList.remove('hidden');
          pay.disabled = false;
        });
    });
    s.body.appendChild(err);
    s.body.appendChild(pay);

    var fail = el('button', { class: 'btn ghost block sm', type: 'button' }, ['See a declined payment']);
    fail.addEventListener('click', function () {
      api('/care/payments/' + intentId + '/confirm', { method: 'POST', body: { method: chosen, simulate: 'failure' } })
        .then(function () { s.close(); toast('Payment declined — nothing was charged.'); })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); });
    });
    s.body.appendChild(fail);
    return s;
  }

  function buyPlan(plan) {
    api('/care/payments', { method: 'POST', body: { purpose: 'subscription', planCode: plan.code } })
      .then(function (res) {
        openPaymentSheet({
          title: 'Care+ ' + plan.name,
          amountInr: plan.priceInr,
          note: plan.tagline,
          intentId: res.payment.id,
          onSuccess: function () { state.loaded = false; refresh(); },
        });
      })
      .catch(function (e) { toast(e.message); });
  }

  function cancelPlan() {
    api('/care/subscription', { method: 'DELETE' })
      .then(function () { toast('Plan cancelled — you keep preview access.'); state.loaded = false; refresh(); })
      .catch(function (e) { toast(e.message); });
  }

  function openPaymentsSheet() {
    var s = sheet('Payment history');
    api('/care/payments')
      .then(function (res) {
        if (!res.payments.length) {
          s.body.appendChild(emptyState('wallet', 'No payments yet.'));
          return;
        }
        res.payments.forEach(function (p) {
          var row = el('div', { class: 'pay-row' });
          row.appendChild(el('strong', { text: rs(p.amountInr) + ' · ' + p.purpose }));
          row.appendChild(el('span', {
            class: 'muted',
            text: shortDate(p.createdAt) + (p.method ? ' · ' + String(p.method).toUpperCase() : ''),
          }));
          row.appendChild(el('span', { class: 'chip ' + (p.status === 'succeeded' ? 'green' : p.status === 'failed' ? 'red' : 'grey'), text: p.status }));
          row.appendChild(demoBadge());
          s.body.appendChild(row);
        });
        s.body.appendChild(el('p', { class: 'muted care-note', text: res.payments[0].mockNotice || '' }));
      })
      .catch(function (e) { toast(e.message); });
  }

  function openPaywallSheet(video) {
    var s = sheet('This short is part of Care+');
    s.body.appendChild(el('p', { class: 'muted', text: video.title }));
    s.body.appendChild(
      el('p', {
        text: 'Care+ unlocks the full doctor shorts library and gives you consultations with the same doctors.',
      }),
    );
    var go = el('button', { class: 'btn primary block', type: 'button' }, ['See plans']);
    go.addEventListener('click', function () { s.close(); openPlanSheet(); });
    s.body.appendChild(go);
  }

  function openBooking(doctor) {
    if (!App.member()) {
      toast('Sign in to talk to a doctor.');
      return;
    }
    var s = sheet('Ask ' + doctor.fullName);
    s.body.appendChild(
      el('p', { class: 'muted', text: doctor.headline + (doctor.city ? ' · ' + doctor.city : '') + ' · ' + (doctor.consultFeeInr ? rs(doctor.consultFeeInr) : 'free') }),
    );

    var form = el('form', { class: 'care-form' });
    var subject = el('input', { type: 'text', placeholder: 'One-line subject (e.g. knee pain for 3 weeks)', maxlength: '160' });
    var question = el('textarea', { rows: '4', placeholder: 'What exactly do you want the doctor to look at?', maxlength: '2000' });
    form.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Subject' }), subject]));
    form.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Your question' }), question]));

    var share = el('input', { type: 'checkbox', checked: 'checked' });
    var shareRow = el('label', { class: 'care-check' }, [
      share,
      el('span', {
        text: 'Share my verified records with this doctor for this consultation only (revocable)',
      }),
    ]);
    form.appendChild(shareRow);
    form.appendChild(
      el('p', {
        class: 'muted care-note',
        text: 'If you share, the doctor sees a one-screen brief built only from values you verified — never the raw scans.',
      }),
    );
    var err = el('p', { class: 'error hidden' });
    form.appendChild(err);
    var submit = el('button', { class: 'btn primary block', type: 'submit' }, ['Send request']);
    form.appendChild(submit);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.classList.add('hidden');
      submit.disabled = true;
      api('/care/consultations', {
        method: 'POST',
        body: {
          memberId: App.member().id,
          doctorId: doctor.id,
          subject: subject.value.trim(),
          question: question.value.trim(),
          shareHealthData: !!share.checked,
        },
      })
        .then(function (res) {
          if (res.payment) {
            s.close();
            openPaymentSheet({
              title: 'Consultation fee',
              amountInr: res.payment.amountInr,
              note: 'Your Care+ quota for this month is used up, so this consultation carries a fee.',
              intentId: res.payment.id,
              onSuccess: function () { state.loaded = false; refresh(); },
            });
          } else {
            s.close();
            toast('Consultation sent — the doctor can now see your brief.');
            refresh().then(function () { openConsultation(res.consultation.id); });
          }
        })
        .catch(function (e) {
          err.textContent = e.message;
          err.classList.remove('hidden');
          submit.disabled = false;
        });
    });
    s.body.appendChild(form);
  }

  function openConsultation(id) {
    var s = sheet('Consultation', { wide: true });
    s.body.appendChild(el('p', { class: 'muted', text: 'Loading…' }));
    api('/care/consultations/' + id)
      .then(function (c) {
        s.body.innerHTML = '';
        var head = el('div', { class: 'consult-head' });
        head.appendChild(el('h4', { text: c.subject }));
        head.appendChild(statusChip(c.status));
        s.body.appendChild(head);
        s.body.appendChild(el('p', { class: 'muted', text: (c.doctor ? c.doctor.fullName + ' · ' + c.doctor.headline : '') + ' · ' + shortDate(c.createdAt) }));

        // consent state
        var consent = el('div', { class: 'consent-box' + (c.consent.granted ? '' : ' muted-box') });
        consent.appendChild(icon(c.consent.granted ? 'shield-check' : 'lock', 16));
        consent.appendChild(el('span', { text: c.consent.note }));
        if (c.consent.granted) {
          var revoke = el('button', { class: 'btn ghost sm', type: 'button' }, ['Revoke access']);
          revoke.addEventListener('click', function () {
            api('/care/consultations/' + id + '/consent/revoke', { method: 'POST', body: {} })
              .then(function () { toast('Access revoked.'); s.close(); openConsultation(id); })
              .catch(function (e) { toast(e.message); });
          });
          consent.appendChild(revoke);
        }
        s.body.appendChild(consent);

        if (c.needsPayment && c.paymentIntentId) {
          var payBtn = el('button', { class: 'btn primary block', type: 'button' }, ['Confirm ' + rs(c.feeInr) + ' and send']);
          payBtn.addEventListener('click', function () {
            s.close();
            openPaymentSheet({
              title: 'Consultation fee',
              amountInr: c.feeInr,
              intentId: c.paymentIntentId,
              onSuccess: function () { refresh().then(function () { openConsultation(id); }); },
            });
          });
          s.body.appendChild(payBtn);
        }

        if (c.doctorReply) {
          var replyBox = el('div', { class: 'reply-box' });
          replyBox.appendChild(el('strong', { text: 'Doctor’s reply' }));
          replyBox.appendChild(el('p', { text: c.doctorReply }));
          s.body.appendChild(replyBox);
        }

        if (c.medicinePlan) {
          var med = el('div', { class: 'med-box' });
          med.appendChild(el('strong', { text: 'Doctor-approved medicine plan' }));
          if (c.medicinePlan.doctorNote) med.appendChild(el('p', { class: 'muted', text: c.medicinePlan.doctorNote }));
          c.medicinePlan.items.forEach(function (item) {
            var row = el('div', { class: 'med-row' });
            row.appendChild(el('strong', { text: item.product || item.name || item.code }));
            if (item.instructions) row.appendChild(el('span', { class: 'muted', text: item.instructions }));
            med.appendChild(row);
          });
          med.appendChild(el('p', { class: 'muted care-note', text: c.medicinePlan.disclaimer }));
          s.body.appendChild(med);
        }

        if (c.recommendedVideos && c.recommendedVideos.length) {
          var rec = el('div', { class: 'care-list' });
          rec.appendChild(el('strong', { text: 'Shorts your doctor attached' }));
          c.recommendedVideos.forEach(function (v) {
            var row = el('button', { class: 'link-row', type: 'button' });
            row.appendChild(icon('play', 16));
            row.appendChild(el('span', { text: v.title + ' · ' + v.durationSec + 's' }));
            row.addEventListener('click', function () { s.close(); openPlayer(v.id); });
            rec.appendChild(row);
          });
          s.body.appendChild(rec);
        }

        var thread = el('div', { class: 'thread' });
        (c.messages || []).forEach(function (m) {
          var bubble = el('div', { class: 'bubble ' + (m.authorRole === 'patient' ? 'me' : m.authorRole === 'doctor' ? 'doc' : 'sys') });
          bubble.appendChild(el('span', { class: 'bubble-meta', text: (m.authorRole === 'patient' ? 'You' : m.authorRole === 'doctor' ? 'Doctor' : 'System') + ' · ' + shortDate(m.createdAt) }));
          bubble.appendChild(el('p', { text: m.body }));
          if (m.videos && m.videos.length) {
            m.videos.forEach(function (v) {
              var link = el('button', { class: 'link-row', type: 'button' });
              link.appendChild(icon('play', 14));
              link.appendChild(el('span', { text: v.title }));
              link.addEventListener('click', function () { s.close(); openPlayer(v.id); });
              bubble.appendChild(link);
            });
          }
          thread.appendChild(bubble);
        });
        s.body.appendChild(thread);

        if (c.status !== 'closed') {
          var replyForm = el('form', { class: 'care-form thread-form' });
          var input = el('input', { type: 'text', placeholder: 'Add a detail the doctor should know…', maxlength: '2000' });
          var send = el('button', { class: 'btn secondary sm', type: 'submit' }, ['Send']);
          replyForm.appendChild(input);
          replyForm.appendChild(send);
          replyForm.addEventListener('submit', function (ev) {
            ev.preventDefault();
            if (!input.value.trim()) return;
            api('/care/consultations/' + id + '/messages', { method: 'POST', body: { body: input.value.trim() } })
              .then(function () { s.close(); openConsultation(id); })
              .catch(function (e) { toast(e.message); });
          });
          s.body.appendChild(replyForm);

          var closeBtn = el('button', { class: 'btn ghost block sm', type: 'button' }, ['Close this consultation']);
          closeBtn.addEventListener('click', function () {
            api('/care/consultations/' + id + '/close', { method: 'POST', body: {} })
              .then(function () { toast('Consultation closed.'); s.close(); refresh(); })
              .catch(function (e) { toast(e.message); });
          });
          s.body.appendChild(closeBtn);
        }
      })
      .catch(function (e) {
        s.body.innerHTML = '';
        s.body.appendChild(el('p', { class: 'error', text: e.message }));
      });
  }

  /* ------------------------------------------------------------ shorts player */

  function openPlayer(videoId) {
    api('/care/videos/' + videoId + '/playback', { method: 'POST', body: {} })
      .then(function (payload) {
        if (payload.mediaKind === 'upload' && payload.stream) return openVideoPlayer(payload);
        return openCaptionPlayer(payload);
      })
      .catch(function (e) {
        if (e.status === 402) openPaywallSheet({ title: 'Care+ library' });
        else toast(e.message);
      });
  }

  function reportWatch(videoId, seconds, completed) {
    if (!seconds) return;
    api('/care/videos/' + videoId + '/views', { method: 'POST', body: { secondsWatched: seconds, completed: !!completed } }).catch(
      function () { /* watch analytics are best-effort */ },
    );
  }

  function openCaptionPlayer(payload) {
    var v = payload.video;
    var s = sheet(v.title);
    var stage = el('div', { class: 'story', 'data-topic': v.topic });
    var progress = el('div', { class: 'story-progress' });
    var bar = el('span');
    progress.appendChild(bar);
    stage.appendChild(progress);
    stage.appendChild(el('span', { class: 'story-doctor', text: (v.doctor ? v.doctor.fullName : 'Doctor') + ' · ' + (v.doctor ? v.doctor.headline : '') }));
    var body = el('div', { class: 'story-body' });
    stage.appendChild(body);
    stage.appendChild(el('span', { class: 'story-count', text: v.durationSec + 's short' }));
    s.body.appendChild(stage);

    var points = (v.keyPoints && v.keyPoints.length ? v.keyPoints : [v.summary || v.title]);
    var perPointMs = Math.max(1600, (v.durationSec * 1000) / points.length);
    var index = 0;
    var elapsed = 0;
    body.appendChild(el('h4', { text: v.title }));
    body.appendChild(el('span', { class: 'muted', text: v.summary || '' }));

    function showPoint(i) {
      var old = body.querySelector('.story-point');
      if (old) body.removeChild(old);
      var p = el('p', { class: 'story-point', text: points[i] });
      body.appendChild(p);
      bar.style.transition = 'none';
      bar.style.width = ((i / points.length) * 100) + '%';
      // force reflow so the transition restarts
      void bar.offsetWidth;
      bar.style.transition = 'width ' + perPointMs + 'ms linear';
      bar.style.width = (((i + 1) / points.length) * 100) + '%';
    }
    showPoint(0);

    var timer = setInterval(function () {
      index += 1;
      elapsed += perPointMs / 1000;
      if (index >= points.length) {
        clearInterval(timer);
        reportWatch(v.id, Math.min(v.durationSec, Math.round(elapsed)), true);
        s.close();
        toast('Short finished — the doctor earns from your watch time.');
        return;
      }
      showPoint(index);
    }, perPointMs);

    s.overlay.addEventListener('click', function (e) {
      if (e.target === s.overlay) {
        clearInterval(timer);
        reportWatch(v.id, Math.min(v.durationSec, Math.round(elapsed)));
      }
    });
    var closeBtn = s.overlay.querySelector('.sheet-head .btn');
    closeBtn.addEventListener('click', function () {
      clearInterval(timer);
      reportWatch(v.id, Math.min(v.durationSec, Math.round(elapsed)));
    });
  }

  function openVideoPlayer(payload) {
    var v = payload.video;
    var s = sheet(v.title, { wide: true });
    var video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = payload.stream.url;
    video.className = 'care-video';
    s.body.appendChild(video);
    if (v.summary) s.body.appendChild(el('p', { class: 'muted', text: v.summary }));
    s.body.appendChild(el('p', { class: 'muted care-note', text: payload.note }));

    var reported = 0;
    video.addEventListener('timeupdate', function () {
      reported = Math.max(reported, Math.floor(video.currentTime));
    });
    var stop = function () {
      reportWatch(v.id, Math.min(v.durationSec, reported), reported >= v.durationSec - 2);
      video.pause();
    };
    s.overlay.querySelector('.sheet-head .btn').addEventListener('click', stop);
    s.overlay.addEventListener('click', function (e) { if (e.target === s.overlay) stop(); });
    video.play().catch(function () { /* autoplay may be blocked — user can press play */ });
  }

  function loadShorts() {
    var q = state.topic ? '?topic=' + encodeURIComponent(state.topic) + '&pageSize=24' : '?pageSize=24';
    api('/care/videos' + q)
      .then(function (res) {
        state.videos = res.items;
        state.videoTopics = res.topics;
        state.access = res.access;
        render();
      })
      .catch(function (e) { toast(e.message); });
  }

  /* -------------------------------------------------------------------- init */

  function init() {
    var nav = App.$('nav-care');
    if (nav) {
      Icons.set(nav.querySelector('.nav-ic'), 'stethoscope', 20);
      nav.addEventListener('click', function () { open(); });
    }
    ['nav-home', 'nav-reports'].forEach(function (id) {
      var b = App.$(id);
      if (b) b.addEventListener('click', function () { close(); });
    });
    App.onSession(function (session) {
      state.loaded = false;
      state.entitlements = null;
      state.consultations = [];
      state.videos = [];
      if (!session && App.$('care-view')) App.$('care-view').innerHTML = '';
    });
    App.onMember(function () {
      if (state.loaded) renderTeaser();
    });
  }

  App.ready(init);
})();
