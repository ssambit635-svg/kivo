/**
 * Dev preview helper: serves the patient app (/app/) at the ROOT of this port
 * so live-preview tools land straight inside the app, not on the landing page.
 * Zero dependencies — pure node http proxy to the real API server (:8080).
 *
 *   node scripts/preview-app-proxy.mjs [targetHost] [targetPort]
 *   PROXY_PORT=8081 by default.
 */
import http from 'node:http';

const TARGET_HOST = process.argv[2] || '127.0.0.1';
const TARGET_PORT = Number(process.argv[3] || 8080);
const PORT = Number(process.env.PROXY_PORT || 8081);

const server = http.createServer((req, res) => {
  let path = req.url || '/';
  if (path === '/' || path === '/?login=1') path = '/app/' + (path.includes('?') ? '?login=1' : '');
  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, path, method: req.method, headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('kivo preview: API server not reachable on :' + TARGET_PORT);
  });
  req.pipe(proxyReq);
});
server.listen(PORT, '0.0.0.0', () => console.log(`kivo app preview (direct) on http://0.0.0.0:${PORT} → http://${TARGET_HOST}:${TARGET_PORT}/app/`));
