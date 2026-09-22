import { test, expect } from '@playwright/test';

async function openLanding(page) {
  await page.goto('/');
  await expect(page.locator('#loader')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#heroHand')).toHaveCSS('opacity', '1');
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
  test(`laptop hero keeps its full-sized hand and pinned depth at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openLanding(page);
    expect(await page.locator('#heroHand').evaluate(el => el.getBoundingClientRect().width)).toBe(920);
    expect(await page.evaluate(() => !!ScrollTrigger.getById('hero-depth')?.pin)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 200));
    await expect.poll(() => page.locator('#hero').evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(0);
    await expect.poll(() => page.locator('#heroImg').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42)).toBeGreaterThan(10);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.locator('#heroImg').evaluate(el => Math.round(new DOMMatrixReadOnly(getComputedStyle(el).transform).m42))).toBe(0);
    await page.setViewportSize({ width: 393, height: 852 });
    await expect.poll(() => page.evaluate(() => !!ScrollTrigger.getById('hero-depth'))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('ColorBends renders, then cleans up without page errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openLanding(page);
  await expect.poll(() => page.evaluate(() => !!window.KivoBends?.get())).toBe(true);
  await expect(page.locator('#weaveStage canvas')).toHaveCount(1);
  await page.locator('#weaveStage').scrollIntoViewIfNeeded();
  await page.mouse.move(150, 300);
  await page.evaluate(() => { KivoBends.get().setScroll(0.5); KivoBends.get().destroy(); });
  await expect(page.locator('#weaveStage canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reduced motion skips hero pin and safely disposes the still frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1366, height: 768 });
  await openLanding(page);
  expect(await page.evaluate(() => !!ScrollTrigger.getById('hero-depth'))).toBe(false);
  await expect.poll(() => page.evaluate(() => window.KivoBends?.get()?.reduced)).toBe(true);
  await page.evaluate(() => KivoBends.get().destroy());
  await expect(page.locator('#weaveStage canvas')).toHaveCount(0);
});

test('no WebGL leaves a visible CSS fallback', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith('webgl') ? null : getContext.call(this, type, ...args);
    };
  });
  await openLanding(page);
  await expect(page.locator('#weaveStage')).toHaveClass(/weave--fallback/);
  expect(await page.evaluate(() => window.KivoBends.get())).toBe(null);
});
