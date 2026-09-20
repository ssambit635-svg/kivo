/* Login UI is local in the APK; only this readiness probe waits for the cloud.
 * Retry GET /health only. Never replay registration, uploads or payments. */
(function () {
  'use strict';
  var pending = null;
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
  function ensureReady() {
    if (pending) return pending;
    var attempts = 0;
    function attempt() {
      attempts += 1;
      status(attempts === 1 ? 'Connecting securely…' : 'Still connecting… Your sign-in screen is ready.');
      return probe().catch(function () {
        if (navigator.onLine === false || attempts >= 6) {
          var message = 'Cannot connect right now. Check your internet and tap Sign in to retry.';
          status(message);
          throw new Error(message);
        }
        return new Promise(function (resolve) { setTimeout(resolve, 2000); }).then(attempt);
      });
    }
    pending = attempt().then(function () { status('Ready to sign in.'); })
      .finally(function () { pending = null; });
    return pending;
  }
  window.KivoConnection = { ensureReady: ensureReady };
})();
