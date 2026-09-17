/**
 * Extra security headers layered on top of helmet.
 *
 * - `apiNoStore`: health data must NEVER be cached — not by browsers, not by
 *   intermediate proxies, not by the PWA service worker's HTTP cache layer.
 *   Applied to the whole /api surface.
 * - `permissionsPolicy`: feature-policy lockdown — the app only ever needs
 *   camera+microphone for its own origin (report scanning, voice journaling);
 *   everything else is denied.
 */
export function apiNoStore() {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  };
}

export function permissionsPolicy() {
  return (_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), ' +
        'magnetometer=(), gyroscope=(), fullscreen=(self)',
    );
    next();
  };
}
