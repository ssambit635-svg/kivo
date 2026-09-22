/* Sign-in readiness for the login screen.
 *
 * Contract (also covered by browser tests):
 *  - Probes GET /api/health ONLY. Never replays registrations, uploads or
 *    payments — a retry is only ever safe for a sign-in itself.
 *  - Gives up visibly within ~12 s with a "Cannot connect…" message so the
 *    user is never stuck staring at a silent form; the Sign-in button stays
 *    live the whole time.
 *  - After giving up it keeps probing QUIETLY in the background (Render's free
 *    tier sleeps and can take 30–60 s to wake). The moment the cloud answers,
 *    the status flips to "Connected" and pending sign-in waiters are released.
 */
(function () {
  'use strict';
  var pending = null;
  var ready = false;
  var bgTimer = null;
  var waiters = [];

  var CANNAO = 'Cannot connect right now. Check your internet and tap Sign in to retry.';

  function status(message) {
    var node = document.getElementById('connection-status');
    if (node) node.textContent = message;
  }

  function probe() {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    return fetch('/api/health', { cache: 'no-store', signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('unavailable');
        return res.json();
      }).then(function (body) {
        if (body.status !== 'ok') throw new Error('unavailable');
      }).finally(function () { clearTimeout(timeout); });
  }

  function markReady() {
    if (ready) return;
    ready = true;
    if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
    status('Ready to sign in.');
    var w = waiters; waiters = [];
    w.forEach(function (cb) { try { cb(true); } catch (e) {} });
  }

  function attemptLoop() {
    var attempts = 0;
    var gaps = [0, 1200, 2200, 3500, 5500, 8000]; // ~12 s of visible patience
    function attempt() {
      attempts += 1;
      status(attempts === 1 ? 'Connecting securely…' : 'Still connecting… Your sign-in screen is ready.');
      return probe().then(function () {
        markReady();
      }).catch(function () {
        if (navigator.onLine === false || attempts >= gaps.length) {
          status(CANNAO);
          throw new Error(CANNAO);
        }
        return new Promise(function (resolve) { setTimeout(resolve, gaps[attempts] - gaps[attempts - 1]); }).then(attempt);
      });
    }
    return attempt();
  }

  function startBackgroundWake() {
    if (bgTimer || ready) return;
    if (typeof setInterval !== 'function') return; // non-browser sandbox (unit tests)
    bgTimer = setInterval(function () {
      probe().then(function () {
        markReady();
      }).catch(function () { /* keep waiting quietly; status stays honest */ });
    }, 4000);
  }

  function ensureReady() {
    if (ready) return Promise.resolve();
    if (pending) return pending;
    pending = attemptLoop()
      .catch(function () {
        // Visible give-up, but keep trying to wake the cloud in the
        // background — first request after a cold sleep is the slowest.
        startBackgroundWake();
        throw new Error(CANNAO);
      })
      .finally(function () { pending = null; });
    return pending;
  }

  window.KivoConnection = {
    ensureReady: ensureReady,
    /** Resolve as soon as the cloud answers (immediately if already up). */
    whenReady: function () {
      if (ready) return Promise.resolve();
      return new Promise(function (resolve) { waiters.push(resolve); });
    },
    isReady: function () { return ready; },
  };
})();
