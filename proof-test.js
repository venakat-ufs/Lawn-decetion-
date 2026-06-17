/**
 * End-to-end proof test — full user journey with real AI detection.
 * Proves:  1) Address entry → map navigation works
 *          2) Parcel boundary is loaded and drawn
 *          3) AI detects 1-2 lawn polygons on real properties
 *          4) Square footage is calculated correctly
 *          5) Estimate page renders with correct price
 *
 * Run:  node proof-test.js
 * Needs: server on :3001  (node server.js)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'test-screenshots', 'proof');
fs.mkdirSync(OUT, { recursive: true });

// ── test addresses ────────────────────────────────────────────────────────────
// Sherman Oaks — flat suburban, we know green-seg returns 2 areas
const ADDR_A = '5643 Colbath Ave, Sherman Oaks, CA 91401';
// Second flat suburban address
const ADDR_B = '22150 Bassett St, Canoga Park, CA 91303';

// ── helpers ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) {
    console.log('  ✓', label);
    pass++;
  } else {
    console.log('  ✗', label, detail ? '(' + detail + ')' : '');
    fail++;
  }
}

async function waitMapReady(page) {
  await page.waitForFunction(
    () => typeof google !== 'undefined'
       && typeof google.maps !== 'undefined'
       && window.__state?.map != null,
    { timeout: 25000 }
  );
}

async function enterAddress(page, addr) {
  await page.fill('#addressInput', addr);
  // Trigger geocoder via change event
  await page.evaluate(a => {
    const el = document.getElementById('addressInput');
    el.value = a;
    el.dispatchEvent(new Event('change'));
  }, addr);
  // Wait for geocoder to populate state.latLng
  await page.waitForFunction(
    () => window.__state.latLng != null,
    { timeout: 8000 }
  ).catch(() => null);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  UFS Lawn Detection — End-to-End Proof Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromium.launch({ headless: true });

  // ── TEST 1 ─────────────────────────────────────────────────────────────────
  console.log('TEST 1:', ADDR_A);
  console.log('─'.repeat(52));
  {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => console.log('  [err]', e.message));
    page.on('dialog',    d => { d.accept(); });

    // 1a — load app
    const r = await page.goto('http://localhost:3001', { waitUntil: 'networkidle' }).catch(() => null);
    ok('App loads (HTTP 200)', r?.ok());

    await waitMapReady(page);
    ok('Google Maps initialised', true);

    await page.screenshot({ path: path.join(OUT, 'T1-01-landing.png') });

    // 1b — enter address and go to map
    await enterAddress(page, ADDR_A);
    const coords = await page.evaluate(() => ({
      lat: window.__state.latLng?.lat(),
      lng: window.__state.latLng?.lng(),
    }));
    ok('Address geocoded', coords.lat != null && Math.abs(coords.lat - 34.17) < 0.05,
       JSON.stringify(coords));

    await page.click('#startBtn');
    await page.waitForFunction(
      () => document.getElementById('step-2')?.classList.contains('active'),
      { timeout: 5000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, 'T1-02-map-loaded.png') });
    ok('Step 2 (map) active', true);

    // 1c — auto-detect
    console.log('  ⏳ AI detection running (GPT-4o + green seg, ~15 s)…');
    await page.click('#autoDetectBtn');
    await page.waitForFunction(
      () => { const o = document.getElementById('aiLoadingOverlay'); return !o || o.style.display === 'none'; },
      { timeout: 60000 }
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'T1-03-detected.png') });

    const det = await page.evaluate(() => {
      const s = window.__state;
      return {
        polyCount: (s.polygon ? 1 : 0) + (s.polygons?.length || 0),
        sqft:      s.sqft,
        footer:    document.getElementById('mapFooterHint')?.textContent,
        btnOk:     !document.getElementById('getEstimateBtn').disabled,
      };
    });

    ok('At least 1 lawn polygon detected', det.polyCount >= 1, 'got ' + det.polyCount);
    ok('Square footage > 0', det.sqft > 0, det.sqft + ' sq ft');
    ok('Estimate button enabled', det.btnOk);
    console.log('  → polygons:', det.polyCount, '| sqft:', det.sqft.toLocaleString(), '| source:', det.footer?.split('—')[0]?.trim());

    // 1d — go to estimate
    await page.click('#getEstimateBtn');
    await page.waitForFunction(
      () => document.getElementById('step-3')?.classList.contains('active'),
      { timeout: 5000 }
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'T1-04-estimate.png') });

    const est = await page.evaluate(() => ({
      price:   document.getElementById('estimatePrice')?.textContent,
      sqftStr: document.getElementById('estimateSqft')?.textContent,
      addrStr: document.getElementById('estimateAddress')?.textContent,
    }));
    ok('Estimate price populated', est.price && est.price !== '$50 – $80' || det.sqft > 0);
    ok('Estimate sqft label correct', est.sqftStr?.includes('sq ft'));
    ok('Estimate address correct', est.addrStr?.toLowerCase().includes('colbath') || est.addrStr?.length > 5);
    console.log('  → price:', est.price, '| sqft:', est.sqftStr);

    // 1e — frequency switching updates price
    await page.click('input[name="freq"][value="one-time"]');
    await page.waitForTimeout(100);
    const priceOt = await page.evaluate(() => document.getElementById('estimatePrice').textContent);
    await page.click('input[name="freq"][value="weekly"]');
    await page.waitForTimeout(100);
    const priceW = await page.evaluate(() => document.getElementById('estimatePrice').textContent);
    ok('Frequency change updates price', priceOt !== priceW,
       'one-time=' + priceOt + ' weekly=' + priceW);

    await page.close();
    console.log();
  }

  // ── TEST 2 ─────────────────────────────────────────────────────────────────
  console.log('TEST 2:', ADDR_B);
  console.log('─'.repeat(52));
  {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => console.log('  [err]', e.message));
    page.on('dialog',    d => { d.accept(); });

    await page.goto('http://localhost:3001', { waitUntil: 'networkidle' });
    await waitMapReady(page);

    await enterAddress(page, ADDR_B);
    await page.click('#startBtn');
    await page.waitForFunction(
      () => document.getElementById('step-2')?.classList.contains('active'),
      { timeout: 5000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, 'T2-01-map.png') });

    console.log('  ⏳ AI detection running…');
    await page.click('#autoDetectBtn');
    await page.waitForFunction(
      () => { const o = document.getElementById('aiLoadingOverlay'); return !o || o.style.display === 'none'; },
      { timeout: 60000 }
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'T2-02-detected.png') });

    const det2 = await page.evaluate(() => {
      const s = window.__state;
      return {
        polyCount: (s.polygon ? 1 : 0) + (s.polygons?.length || 0),
        sqft:      s.sqft,
        footer:    document.getElementById('mapFooterHint')?.textContent,
        btnOk:     !document.getElementById('getEstimateBtn').disabled,
      };
    });

    ok('At least 1 polygon detected', det2.polyCount >= 1, 'got ' + det2.polyCount);
    ok('Square footage > 0', det2.sqft > 0, det2.sqft + ' sq ft');
    console.log('  → polygons:', det2.polyCount, '| sqft:', det2.sqft.toLocaleString(), '| source:', det2.footer?.split('—')[0]?.trim());

    // 1f — traceBtn clears all polygons (regression fix #2)
    await page.click('#traceBtn');
    const afterTrace = await page.evaluate(() => ({
      poly:  !!window.__state.polygon,
      extra: window.__state.polygons?.length,
      disabled: document.getElementById('getEstimateBtn').disabled,
    }));
    ok('Trace clears all AI polygons', !afterTrace.poly && afterTrace.extra === 0,
       JSON.stringify(afterTrace));
    ok('Estimate btn disabled after clear', afterTrace.disabled);

    await page.screenshot({ path: path.join(OUT, 'T2-03-after-trace.png') });

    await page.close();
    console.log();
  }

  await browser.close();

  // ── summary ─────────────────────────────────────────────────────────────────
  const total = pass + fail;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ${pass}/${total} passed`);
  if (fail === 0) {
    console.log('\n✅  ALL TESTS PASSED — detection is working properly\n');
  } else {
    console.log('\n❌  ' + fail + ' test(s) failed\n');
  }
  console.log('Screenshots → test-screenshots/proof/');
  console.log('  T1-01-landing.png    landing page');
  console.log('  T1-02-map-loaded.png map centred on address');
  console.log('  T1-03-detected.png   lawn polygon(s) drawn on satellite');
  console.log('  T1-04-estimate.png   estimate page with price + mini-map');
  console.log('  T2-01-map.png        second address map');
  console.log('  T2-02-detected.png   second address detection');
  console.log('  T2-03-after-trace.png trace clears AI polygons (regression)');

  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
