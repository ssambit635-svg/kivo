import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..', 'frontend');

async function signIn(page, email = 'demo@kivo.dev', password = 'Kivo!Demo#2026') {
  await page.locator('#in-email').fill(email);
  await page.locator('#in-password').fill(password);
  await page.locator('#auth-submit').click();
}

// The 2026 Celeste redesign retired the topbar logout pill; signing out now
// lives in Profile (avatar -> Sign out), so the journeys follow the real UX.
//
// Two screens own the app on their own schedule:
//   * the cinematic opening intro (#intro) — first tab open, up to ~4.3 s;
//   * personalization onboarding (#onboarding) + the welcome card
//     (#bot-welcome) — they land ~0.5 s AFTER the session does, and skipping
//     onboarding reveals the welcome card.
// A helper that only removes overlays it happens to see races both of them and
// loses on a slow CI runner (exactly how PR #38 went red), so:
//   * skipIntro taps the film away as soon as it shows up;
//   * settled polls until the screen has been CLEAR for a full second.
async function skipIntro(page) {
  const intro = page.locator('#intro');
  // bootIntro retires #intro before 'load' fires (reduced motion, or the
  // once-per-tab seen flag on this journey's later navigations), so an absent
  // element means there is no film to skip — don't wait for one.
  if ((await intro.count()) === 0) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await intro.click({ timeout: 2000 }); // a tap anywhere skips the film
    } catch { /* already gone, or not up yet */ }
    const gone = await intro.waitFor({ state: 'detached', timeout: 3000 }).then(() => true).catch(() => false);
    if (gone) return;
  }
  // The film ends on its own even if every tap raced the listener.
  await intro.waitFor({ state: 'detached', timeout: 7000 }).catch(() => {});
}

async function settled(page) {
  // the first-light splash dies as soon as the intro takes over — wait it out anyway
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  const covered = () => page.evaluate(() =>
    !!document.getElementById('onboarding') || !!document.getElementById('bot-welcome'));
  const dismiss = () => page.evaluate(() => {
    for (const id of ['onboarding', 'bot-welcome']) {
      const n = document.getElementById(id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
    document.body.style.overflow = '';
  });
  const deadline = Date.now() + 12000;
  let clearAt = null;
  while (Date.now() < deadline) {
    if (await covered()) {
      clearAt = null; // an overlay just showed up — drop it and keep watching
      await dismiss();
      await page.waitForTimeout(350);
    } else if (clearAt === null) {
      clearAt = Date.now(); // first clean sample; confirm it stays clean
      await page.waitForTimeout(400);
    } else if (Date.now() - clearAt >= 1100) {
      return; // clear and stable — the journeys can have the screen
    } else {
      await page.waitForTimeout(250);
    }
  }
}

async function signOut(page) {
  await settled(page);
  await page.locator('#topbar-avatar').click();
  await page.locator('#page-profile .link-row', { hasText: 'Sign out' }).click();
}

// Mirrors Android's bundled /native/ document/asset responses, not its API.
// Device-level WebView/permissions still need a real phone check.
async function nativeShell(page) {
  await page.addInitScript(() => { window.KivoNative = { isNative: () => true }; });
  await page.route('**/native/**', async route => {
    const name = new URL(route.request().url()).pathname.slice('/native/'.length) || 'index.html';
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
    const filePath = path.join(FRONTEND_ROOT, name);
    try {
      const body = await fs.readFile(filePath);
      await route.fulfill({ body, contentType: types[path.extname(name)] || 'application/json' });
    } catch {
      // Fallback to 404 with JSON so the test shows a clear miss rather than hanging
      await route.fulfill({ status: 404, body: `missing frontend asset: ${name}`, contentType: 'text/plain' });
    }
  });
}

test('old mobile URL opens login, not sample data; patient features use the API', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/m/');
  await skipIntro(page); // don't pay the brand film in every journey
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#dash-view')).toBeHidden();
  await signIn(page);
  await expect(page.locator('#dash-view')).toBeVisible();
  await expect(page.locator('#member-name')).not.toHaveText('—');
  await settled(page);
  await page.locator('#nav-ask').click(); // Ask lives on its own tab since the 2026 redesign
  await page.locator('#ask-input').fill('What changed in my health?');
  const ask = page.waitForResponse(r => r.url().includes('/ask') && r.request().method() === 'POST');
  await page.locator('#ask-send').click();
  expect((await ask).status()).toBe(200);
  await page.locator('#nav-care').click();
  await expect(page.locator('#care-view')).toBeVisible();
  await expect(page.locator('#care-view')).toContainText('Care');
  await signOut(page);
  await expect(page.locator('#auth-view')).toBeVisible();
  expect(errors).toEqual([]);
});

test('bundled native login appears even with no API; no server picker or download button', async ({ page }) => {
  await nativeShell(page);
  await page.route('**/api/**', route => route.abort('internetdisconnected'));
  await page.goto('/native/?login=1');
  await skipIntro(page); // don't pay the brand film in every journey
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('.download-apk-btn')).toBeHidden();
  await expect(page.locator('#dash-view')).toBeHidden();
  await expect(page.locator('#connection-status')).toContainText('Cannot connect', { timeout: 15000 });
  await expect(page.locator('#auth-submit')).toBeEnabled();
});

test('native cold launch KEEPS the session — only signing out ends it', async ({ page }) => {
  await nativeShell(page);
  await page.goto('/native/?login=1'); // no stored session yet → sign-in screen
  await expect(page.locator('#auth-view')).toBeVisible();
  await signIn(page);
  await expect(page.locator('#dash-view')).toBeVisible();

  // Older APK builds still append ?login=1 on every cold start; that must no
  // longer throw the device session away (the "sign in again every launch" bug).
  await page.goto('/native/?login=1');
  await skipIntro(page); // don't pay the brand film in every journey
  await expect(page.locator('#dash-view')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mt.tokens'))).not.toBeNull();

  await page.reload();
  await expect(page.locator('#dash-view')).toBeVisible();

  // Sign out is the one thing that ends the session.
  await signOut(page);
  await expect(page.locator('#auth-view')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mt.tokens'))).toBeNull();
});

test('sleeping cloud recovers without replaying sign-in POST', async ({ page }) => {
  let healthCalls = 0;
  let loginCalls = 0;
  await page.route('**/api/health', route => {
    healthCalls += 1;
    return healthCalls < 3 ? route.fulfill({ status: 503, body: 'Waking up' }) : route.continue();
  });
  page.on('request', r => { if (r.url().endsWith('/api/auth/login')) loginCalls += 1; });
  await page.goto('/app/');
  await skipIntro(page); // don't pay the brand film in every journey
  await signIn(page);
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#dash-view')).toBeVisible({ timeout: 15000 });
  expect(healthCalls).toBe(3);
  expect(loginCalls).toBe(1);
});

test('doctor toggles to Doctor sign-in with a certificate number and lands in the console', async ({ page }) => {
  await page.goto('/app/');
  await skipIntro(page); // don't pay the brand film in every journey
  await page.locator('#role-doctor').click();
  await expect(page.locator('#row-regno')).toBeVisible();

  // Wrong number → refused, with the certificate mismatch explained.
  await page.locator('#in-email').fill('dr.mohan@kivo.dev');
  await page.locator('#in-password').fill('Kivo!Doctor#2026');
  await page.locator('#in-regno').fill('MCI-000000');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-error')).toContainText('registration number');

  // The number on the certificate on file → straight into the doctor console.
  await page.locator('#in-regno').fill('MCI-DEMO-4471');
  await page.locator('#auth-submit').click();
  await expect(page).toHaveURL(/\/doctor\/$/);
  await expect(page.locator('#doc-console')).toBeVisible();
  await expect(page.locator('#doc-auth')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('mt.tokens'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('kivo.role-handoff'))).toBeNull();
  // The doctor session lives under the doctor console's own key.
  expect(await page.evaluate(() => localStorage.getItem('mt.doctor.tokens'))).not.toBeNull();
});

test('a doctor account on the Patient toggle is sent to the Doctor toggle, not signed in as a patient', async ({ page }) => {
  await page.goto('/app/');
  await skipIntro(page); // don't pay the brand film in every journey
  await signIn(page, 'dr.mohan@kivo.dev', 'Kivo!Doctor#2026');
  await expect(page.locator('#row-regno')).toBeVisible();
  await expect(page.locator('#auth-error')).toContainText('doctor account');
  await expect(page.locator('#dash-view')).toBeHidden();
});

test('create-account form creates a real account and member', async ({ page }) => {
  await page.goto('/app/');
  await skipIntro(page); // don't pay the brand film in every journey
  await page.locator('#tab-register').click();
  await page.locator('#in-name').fill('Hackathon Test');
  await signIn(page, `browser-${Date.now()}@kivo.test`, 'Kivo!Browser#2026');
  await expect(page.locator('#dash-view')).toBeVisible();
  await expect(page.locator('#member-name')).toHaveText('Hackathon Test');
});
