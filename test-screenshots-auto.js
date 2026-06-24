/**
 * Playwright screenshot test — opens the app, runs detection for each address,
 * captures the map with polygon traces, saves to test-screenshots/
 * Run: node test-screenshots-auto.js
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ADDRESSES = [
  '1012 N Sunset Canyon Dr, Burbank, CA 91504',
  '5533 Radford Ave, Valley Village, CA 91601',
  '7431 N Frederic St, Burbank, CA 91505',
  '11540 Laurelwood Dr, Studio City, CA 91604',
  '4530 Auckland Ave, North Hollywood, CA 91601',
  '15300 Magnolia Blvd, Sherman Oaks, CA 91403',
  '1845 N Kenwood St, Burbank, CA 91505',
];

const OUT_DIR = path.join(__dirname, 'test-screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

function slug(addr) {
  return addr.replace(/[^a-z0-9]+/gi, '_').replace(/_+/g, '_').toLowerCase().slice(0, 40);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  for (let i = 0; i < ADDRESSES.length; i++) {
    const addr = ADDRESSES[i];
    console.log(`\n[${i + 1}/${ADDRESSES.length}] ${addr}`);

    const page = await context.newPage();
    try {
      await page.goto('http://localhost:3001', { waitUntil: 'networkidle' });

      // Type address slowly so Google Places autocomplete fires
      await page.click('#addressInput');
      await page.type('#addressInput', addr, { delay: 60 });

      // Wait for autocomplete dropdown suggestion to appear
      await page.waitForSelector('.pac-item', { timeout: 8000 });
      await page.waitForTimeout(400);

      // Click the first suggestion to set state.latLng
      await page.click('.pac-item:first-child');
      await page.waitForTimeout(600);

      // Now click Get Free Estimate (state.latLng is set)
      await page.click('#startBtn');

      // Wait for step-2 to become active (map screen)
      await page.waitForSelector('#step-2.active', { timeout: 10000 });
      await page.waitForTimeout(1200); // let map render

      // Click Auto-Detect Lawn button
      await page.click('#autoDetectBtn');
      console.log('  → Auto-detect clicked, waiting for result...');

      // Wait for autoDetectBtn loading state to clear
      await page.waitForFunction(() => {
        const btn = document.getElementById('autoDetectBtn');
        return btn && !btn.classList.contains('loading');
      }, { timeout: 90000 });

      // Extra settle time for polygon draw on canvas
      await page.waitForTimeout(2000);

      // Screenshot the map step
      const filename = `detect_${String(i + 1).padStart(2, '0')}_${slug(addr)}.png`;
      const outPath = path.join(OUT_DIR, filename);
      await page.screenshot({ path: outPath, fullPage: false });
      console.log(`  ✅ saved → ${filename}`);

    } catch (err) {
      console.log(`  ❌ failed: ${err.message}`);
      const errFile = path.join(OUT_DIR, `error_${i + 1}_${slug(addr)}.png`);
      await page.screenshot({ path: errFile }).catch(() => {});
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log(`\nDone. Screenshots in: ${OUT_DIR}`);
})();
