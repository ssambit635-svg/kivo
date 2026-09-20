import { describe, it, expect, vi, afterEach } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
const script = fs.readFileSync(new URL('../../../frontend/connection.js', import.meta.url), 'utf8');
function setup(fetch, online = true) {
  const message = { textContent: '' };
  const context = { window: {}, document: { getElementById: () => message }, navigator: { onLine: online }, fetch, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(script, context);
  return { ready: context.window.KivoConnection.ensureReady, message };
}
afterEach(() => vi.useRealTimers());
describe('cloud readiness without replacing login', () => {
  it('coalesces concurrent probes, never sends credentials', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    const { ready, message } = setup(fetch);
    const first = ready();
    expect(ready()).toBe(first);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/health');
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    expect(message.textContent).toBe('Ready to sign in.');
  });
  it('stops immediately when offline, and a later retry can succeed', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    const { ready, message } = setup(fetch, false);
    await expect(ready()).rejects.toThrow('Check your internet');
    expect(message.textContent).not.toMatch(/backend|npm|localhost|Render/);
    await expect(ready()).resolves.toBeUndefined();
  });
  it('bounds 503 retries and leaves a retry message, not HTML/JSON output', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    const { ready } = setup(fetch);
    const assertion = expect(ready()).rejects.toThrow('tap Sign in');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('aborts a hung health probe and bounds total wait', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('timeout')));
    }));
    const { ready } = setup(fetch);
    const assertion = expect(ready()).rejects.toThrow('Cannot connect');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls.every(([, o]) => o.signal.aborted)).toBe(true);
  });
  it('does not treat a proxy HTML response as a healthy API', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('HTML'); } });
    await expect(setup(fetch, false).ready()).rejects.toThrow('Cannot connect');
  });
});
