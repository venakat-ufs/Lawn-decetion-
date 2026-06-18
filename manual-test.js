/**
 * Manual verification — real AI lawn detection on a live address.
 * No API mocking. Uses real GPT-4o + Google Maps.
 *
 * Run: node manual-test.js
 * Requires: server running on :3001
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SCREENSHOTS = path.join(__dirname, 'test-screenshots');
if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS);

// Flat Burbank residential street — clear front lawn and reliable positive case
const TEST_ADDRESS = '1012 N Sunset Canyon Dr, Burbank, CA 91504';

async function run() {
  console.log('\nManual lawn detection verification');
  console.log('Address:', TEST_ADDRESS);
  console.log('─'.repeat(50));

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  page.setDefaultTimeout(60000);

  page.on('pageerror', err  => console.log('  [error]', err.message));
  page.on('dialog',   dlg  => { console.log('  [alert]', dlg.message()); dlg.accept(); });

  try {
    // Load app
    await page.goto('http://localhost:3001', { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(SCREENSHOTS, 'real-01-loaded.png') });
    console.log('✓ App loaded');

    // Wait for Maps + initMap
    await page.waitForFunction(
      () => window.__state?.map !== null && window.__state?.map !== undefined,
      { timeout: 25000 }
    );
    console.log('✓ Google Maps ready');

    // Type address and geocode it using the app's own geocoder
    await page.fill('#addressInput', TEST_ADDRESS);
    await page.evaluate((addr) => {
      // Trigger the geocoder via change event (uses google.maps.Geocoder in app.js)
      const input = document.getElementById('addressInput');
      input.value = addr;
      input.dispatchEvent(new Event('change'));
    }, TEST_ADDRESS);

    // Wait for geocoder to populate state.latLng (up to 5s)
    await page.waitForFunction(
      () => window.__state.latLng !== null && window.__state.latLng !== undefined,
      { timeout: 8000 }
    ).catch(() => console.log('  ⚠ Geocoder timeout — will try Start button anyway'));

    // Navigate to step 2 via Start button (same as real user)
    await page.click('#startBtn');
    await page.waitForFunction(
      () => document.getElementById('step-2')?.classList.contains('active'),
      { timeout: 5000 }
    ).catch(() => console.log('  ⚠ Step 2 transition timeout'));

    // Let map tile settle
    await page.waitForTimeout(2500);

    // Read geocoded coordinates
    const coords = await page.evaluate(() => ({
      lat: window.__state.latLng?.lat(),
      lng: window.__state.latLng?.lng(),
    }));
    console.log('✓ Geocoded to', coords.lat?.toFixed(6), coords.lng?.toFixed(6));
    await page.screenshot({ path: path.join(SCREENSHOTS, 'real-02-map.png') });
    console.log('✓ Map step opened at address');

    // Click Auto-Detect (real API call)
    console.log('⏳ Running AI detection (real GPT-4o call, may take ~15s)…');
    await page.click('#autoDetectBtn');

    // Wait for detection to finish (up to 60s for real AI)
    await page.waitForFunction(
      () => { const el = document.getElementById('aiLoadingOverlay'); return !el || el.style.display === 'none'; },
      { timeout: 60000 }
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'real-03-detected.png') });
    console.log('✓ Detection complete');

    // Read back results
    const result = await page.evaluate(() => {
      const s = window.__state;
      return {
        polyCount: (s.polygon ? 1 : 0) + (s.polygons?.length || 0),
        sqft:      s.sqft,
        footer:    document.getElementById('mapFooterHint')?.textContent?.trim(),
        btnOk:     !document.getElementById('getEstimateBtn').disabled,
      };
    });

    console.log('\n── Detection results ───────────────────────────');
    console.log('  Polygons drawn :', result.polyCount);
    console.log('  Total sqft     :', result.sqft.toLocaleString(), 'sq ft');
    console.log('  Footer         :', result.footer);
    console.log('  Estimate btn   :', result.btnOk ? 'enabled' : 'disabled');
    console.log('────────────────────────────────────────────────');

    if (result.polyCount === 0) {
      console.log('\n⚠  No polygons drawn — check real-03-detected.png');
    } else if (result.polyCount === 1) {
      console.log('\n⚠  Only 1 lawn area detected — check if there should be 2');
    } else {
      console.log('\n✓ Multiple lawn areas detected correctly');
    }

    console.log('\nScreenshots saved to test-screenshots/');
    console.log('  real-02-map.png      → satellite view before detection');
    console.log('  real-03-detected.png → detection result overlaid');

  } catch (err) {
    console.error('\nError:', err.message);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'real-error.png') }).catch(() => {});
  } finally {
    await browser.close();
  }
}

run();
