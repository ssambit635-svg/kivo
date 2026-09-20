import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

async function signIn(page, email = 'demo@kivo.dev', password = 'Kivo!Demo#2026') {
  await page.locator('#in-email').fill(email);
  await page.locator('#in-password').fill(password);
  await page.locator('#auth-submit').click();
}

// Mirrors Android's bundled /native/ document/asset responses, not its API.
// Device-level WebView/permissions still need a real phone check.
async function nativeShell(page) {
  await page.addInitScript(() => { window.KivoNative = { isNative: () => true }; });
  await page.route('**/native/**', async route => {
    const name = new URL(route.request().url()).pathname.slice('/native/'.length) || 'index.html';
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
    await route.fulfill({ body: await fs.readFile(path.resolve('../frontend', name)), contentType: types[path.extname(name)] || 'application/json' });
  });
}

test('old mobile URL opens login, not sample data; patient features use the API', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/m/');
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#dash-view')).toBeHidden();
  await signIn(page);
  await expect(page.locator('#dash-view')).toBeVisible();
  await expect(page.locator('#member-name')).not.toHaveText('—');
  await page.locator('#ask-input').fill('What changed in my health?');
  const ask = page.waitForResponse(r => r.url().includes('/ask') && r.request().method() === 'POST');
  await page.locator('#ask-send').click();
  expect((await ask).status()).toBe(200);
  await page.locator('#nav-care').click();
  await expect(page.locator('#care-view')).toBeVisible();
  await expect(page.locator('#care-view')).toContainText('Care');
  await page.locator('#btn-logout').click();
  await expect(page.locator('#auth-view')).toBeVisible();
  expect(errors).toEqual([]);
});

test('bundled native login appears even with no API; no server picker or download button', async ({ page }) => {
  await nativeShell(page);
  await page.route('**/api/**', route => route.abort('internetdisconnected'));
  await page.goto('/native/?login=1');
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('.download-apk-btn')).toBeHidden();
  await expect(page.locator('#dash-view')).toBeHidden();
  await expect(page.locator('#connection-status')).toContainText('Cannot connect', { timeout: 15000 });
  await expect(page.locator('#auth-submit')).toBeEnabled();
});

test('native cold launch clears old session; ordinary reload keeps login', async ({ page }) => {
  await nativeShell(page);
  await page.goto('/native/?login=1');
  await signIn(page);
  await expect(page.locator('#dash-view')).toBeVisible();
  await page.reload();
  await expect(page.locator('#dash-view')).toBeVisible();
  await page.goto('/native/?login=1');
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
  await signIn(page);
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#dash-view')).toBeVisible({ timeout: 15000 });
  expect(healthCalls).toBe(3);
  expect(loginCalls).toBe(1);
});

test('doctor signs in once and reaches role-separated console', async ({ page }) => {
  await page.goto('/app/');
  await signIn(page, 'dr.mohan@kivo.dev', 'Kivo!Doctor#2026');
  await expect(page).toHaveURL(/\/doctor\/$/);
  await expect(page.locator('#doc-console')).toBeVisible();
  await expect(page.locator('#doc-auth')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('mt.tokens'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('kivo.role-handoff'))).toBeNull();
});

test('create-account form creates a real account and member', async ({ page }) => {
  await page.goto('/app/');
  await page.locator('#tab-register').click();
  await page.locator('#in-name').fill('Hackathon Test');
  await signIn(page, `browser-${Date.now()}@kivo.test`, 'Kivo!Browser#2026');
  await expect(page.locator('#dash-view')).toBeVisible();
  await expect(page.locator('#member-name')).toHaveText('Hackathon Test');
});
