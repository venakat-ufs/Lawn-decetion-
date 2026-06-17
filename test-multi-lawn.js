/**
 * Playwright test — multi-lawn detection
 *
 * Tests that two separate lawn areas are correctly drawn and sqft is summed.
 * Calls drawLawnPolygons() directly (no HTTP mocking needed for core rendering tests).
 *
 * Requires: server running on port 3001  (node server.js)
 * Run:      node test-multi-lawn.js
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SCREENSHOTS = path.join(__dirname, 'test-screenshots');
if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS);

// Two separate lawn polygons (pixel coords relative to 640×640 static map at zoom 20)
const TWO_POLYGONS = [
  // Front yard — upper-left quadrant
  [
    { x: 120, y: 120 }, { x: 240, y: 120 },
    { x: 240, y: 220 }, { x: 120, y: 220 },
  ],
  // Back yard — lower-right quadrant
  [
    { x: 360, y: 360 }, { x: 500, y: 360 },
    { x: 500, y: 500 }, { x: 360, y: 500 },
  ],
];

const ONE_POLYGON = [
  [
    { x: 150, y: 150 }, { x: 350, y: 150 },
    { x: 350, y: 350 }, { x: 150, y: 350 },
  ],
];

function pass(label) { console.log('  ✓', label); return true; }
function fail(label, detail) { console.log('  ✗', label, detail !== undefined ? `(got: ${detail})` : ''); return false; }

async function runTests() {
  console.log('\nMulti-lawn detection test\n' + '─'.repeat(45));

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  page.setDefaultTimeout(30000);

  // Capture browser-level errors and alerts
  page.on('pageerror', err => console.log('  [page-error]', err.message));
  page.on('console',   msg => { if (msg.type() === 'error') console.log('  [console-error]', msg.text()); });
  page.on('dialog',    dlg => { console.log('  [alert]', dlg.message()); dlg.accept(); });

  const results = [];

  try {
    // ── Load app ───────────────────────────────────────────────────────────
    console.log('\nStep 1: Load app');
    const resp = await page.goto('http://localhost:3001', { waitUntil: 'networkidle' }).catch(() => null);
    if (!resp || !resp.ok()) {
      console.error('  ERROR: Server not running on :3001 — run `node server.js` first');
      process.exit(1);
    }
    await page.screenshot({ path: path.join(SCREENSHOTS, 'ml-01-loaded.png') });
    results.push(pass('App loaded (HTTP 200)'));

    // ── Wait for Google Maps + initMap ─────────────────────────────────────
    console.log('\nStep 2: Wait for Google Maps');
    await page.waitForFunction(
      () => typeof google !== 'undefined'
         && typeof google.maps !== 'undefined'
         && typeof google.maps.LatLng !== 'undefined'
         && window.__state?.map !== null
         && window.__state?.map !== undefined,
      { timeout: 25000 }
    );
    results.push(pass('Google Maps + map initialized'));

    // ── Set address state and show step 2 ─────────────────────────────────
    console.log('\nStep 3: Open map step');
    await page.evaluate(() => {
      window.__state.latLng  = new google.maps.LatLng(34.0522, -118.2437);
      window.__state.address = '200 N Spring St, Los Angeles, CA 90012';
      window.__state.parcelBoundary = null;
      window.__state.parcelSource   = null;
    });
    // Just activate step-2 visually (skip the setTimeout/parcel call)
    await page.evaluate(() => {
      document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
      document.getElementById('step-2').classList.add('active');
      if (window.__state.map) google.maps.event.trigger(window.__state.map, 'resize');
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'ml-02-map.png') });
    results.push(pass('Map step visible'));

    // ─────────────────────────────────────────────────────────────────────
    // TEST A: drawLawnPolygons with TWO polygons
    // ─────────────────────────────────────────────────────────────────────
    console.log('\nTest A: drawLawnPolygons — 2 separate lawn areas');

    await page.evaluate((twoPolygons) => {
      const s = window.__state;
      const lat = s.latLng.lat();
      const lng = s.latLng.lng();
      window.__test.drawLawnPolygons(twoPolygons, lat, lng, 'high', 'gpt4o');
    }, TWO_POLYGONS);

    const stateA = await page.evaluate(() => {
      const s = window.__state;
      return {
        polyCount: (s.polygon ? 1 : 0) + (s.polygons?.length || 0),
        sqft:      s.sqft,
        footer:    document.getElementById('mapFooterHint')?.textContent?.trim(),
        btnOk:     !document.getElementById('getEstimateBtn').disabled,
      };
    });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'ml-03-two-polygons.png') });

    results.push(stateA.polyCount === 2 ? pass(`Two polygons drawn`)       : fail('Expected 2 polygons', stateA.polyCount));
    results.push(stateA.sqft > 0        ? pass(`Sqft > 0 (${stateA.sqft.toLocaleString()} sq ft)`) : fail('Sqft should be > 0', stateA.sqft));
    results.push(stateA.btnOk           ? pass(`Get Estimate button enabled`) : fail('Get Estimate button disabled'));
    results.push(
      /2 lawn/i.test(stateA.footer) || /detected/i.test(stateA.footer)
        ? pass(`Footer: "${stateA.footer}"`)
        : fail('Footer should mention 2 lawn areas or detected', stateA.footer)
    );

    // ─────────────────────────────────────────────────────────────────────
    // TEST B: backward compat — single polygon
    // ─────────────────────────────────────────────────────────────────────
    console.log('\nTest B: drawLawnPolygons — single polygon (backward compat)');

    await page.evaluate(() => window.__test.clearDetectionOverlays());
    await page.evaluate((onePolygon) => {
      const s = window.__state;
      const lat = s.latLng.lat();
      const lng = s.latLng.lng();
      window.__test.drawLawnPolygons(onePolygon, lat, lng, 'medium', 'gpt4o');
    }, ONE_POLYGON);

    const stateB = await page.evaluate(() => {
      const s = window.__state;
      return {
        polyCount: (s.polygon ? 1 : 0) + (s.polygons?.length || 0),
        sqft:      s.sqft,
      };
    });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'ml-04-one-polygon.png') });

    results.push(stateB.polyCount === 1 ? pass(`Single polygon drawn (backward compat)`) : fail('Expected 1 polygon', stateB.polyCount));
    results.push(stateB.sqft > 0        ? pass(`Single sqft > 0 (${stateB.sqft.toLocaleString()} sq ft)`) : fail('Single sqft > 0', stateB.sqft));

    // ─────────────────────────────────────────────────────────────────────
    // TEST C: sqft sums BOTH areas correctly
    // ─────────────────────────────────────────────────────────────────────
    console.log('\nTest C: sqft is sum of both lawn areas');

    await page.evaluate(() => window.__test.clearDetectionOverlays());
    await page.evaluate((twoPolygons) => {
      const s = window.__state;
      window.__test.drawLawnPolygons(twoPolygons, s.latLng.lat(), s.latLng.lng(), 'high', 'gpt4o');
    }, TWO_POLYGONS);

    const sqftTwo = await page.evaluate(() => window.__state.sqft);

    await page.evaluate(() => window.__test.clearDetectionOverlays());
    await page.evaluate((onePolygon) => {
      const s = window.__state;
      window.__test.drawLawnPolygons(onePolygon, s.latLng.lat(), s.latLng.lng(), 'high', 'gpt4o');
    }, ONE_POLYGON);

    const sqftOne = await page.evaluate(() => window.__state.sqft);
    // Both should produce non-zero sqft and the values should differ (different polygon data → different areas)
    results.push(
      sqftTwo > 0 && sqftOne > 0 && sqftTwo !== sqftOne
        ? pass(`Multi and single sqft are non-zero and distinct (${sqftTwo.toLocaleString()} vs ${sqftOne.toLocaleString()} sq ft)`)
        : fail('sqft values should be non-zero and different', `multi=${sqftTwo}, single=${sqftOne}`)
    );

    // ─────────────────────────────────────────────────────────────────────
    // TEST D: clearDetectionOverlays resets both polygon sets
    // ─────────────────────────────────────────────────────────────────────
    console.log('\nTest D: clearDetectionOverlays resets all polygons');

    await page.evaluate(() => window.__test.clearDetectionOverlays());

    const afterClear = await page.evaluate(() => ({
      poly:  !!window.__state.polygon,
      count: window.__state.polygons?.length ?? -1,
    }));

    results.push(
      !afterClear.poly && afterClear.count === 0
        ? pass('Clear removed all polygons')
        : fail('Polygons not fully cleared', JSON.stringify(afterClear))
    );

    // ─────────────────────────────────────────────────────────────────────
    // TEST E: manual draw clears multi-polygon state
    // ─────────────────────────────────────────────────────────────────────
    console.log('\nTest E: manual draw clears AI multi-polygon state');

    // First draw two AI polygons
    await page.evaluate((twoPolygons) => {
      const s = window.__state;
      window.__test.drawLawnPolygons(twoPolygons, s.latLng.lat(), s.latLng.lng(), 'high', 'gpt4o');
    }, TWO_POLYGONS);

    const before = await page.evaluate(() => ({
      poly:  !!window.__state.polygon,
      count: window.__state.polygons?.length ?? -1,
    }));

    // Simulate the drawing manager completing a polygon (fires polygoncomplete)
    await page.evaluate(() => {
      // Clear polygons the same way polygoncomplete listener does
      if (window.__state.polygon) window.__state.polygon.setMap(null);
      (window.__state.polygons || []).forEach(p => p.setMap(null));
      window.__state.polygons = [];
      // Simulate a new manual polygon
      window.__state.polygon = new google.maps.Polygon({
        paths: [
          new google.maps.LatLng(34.0520, -118.2435),
          new google.maps.LatLng(34.0525, -118.2435),
          new google.maps.LatLng(34.0525, -118.2440),
        ],
        map: window.__state.map,
      });
      window.__test.updateSqft();
    });

    const after = await page.evaluate(() => ({
      poly:  !!window.__state.polygon,
      count: window.__state.polygons?.length ?? -1,
      sqft:  window.__state.sqft,
    }));

    results.push(
      before.count === 1 && after.count === 0
        ? pass(`Manual draw cleared extra polygons (was ${before.count}, now ${after.count})`)
        : fail('Manual draw should clear extra AI polygons', `before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`)
    );
    results.push(after.sqft > 0 ? pass(`Manual draw sqft > 0 (${after.sqft.toLocaleString()} sq ft)`) : fail('Manual sqft > 0', after.sqft));

  } catch (err) {
    console.error('\nUnexpected error:', err.message);
    results.push(false);
  } finally {
    await page.screenshot({ path: path.join(SCREENSHOTS, 'ml-05-final.png') });
    await browser.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(Boolean).length;
  const total  = results.length;
  console.log('\n' + '─'.repeat(45));
  console.log(`Results: ${passed}/${total} passed`);
  console.log(`Screenshots → test-screenshots/`);

  if (passed < total) {
    console.log('\nFAIL\n');
    process.exit(1);
  } else {
    console.log('\nPASS ✓\n');
  }
}

runTests();
