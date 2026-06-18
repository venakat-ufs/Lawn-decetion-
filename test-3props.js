/**
 * 3-property detection test — takes a screenshot after AI detects lawn on each.
 * Run: node test-3props.js   (server must NOT be running)
 */

const { chromium } = require('playwright');
const { spawn }    = require('child_process');
const fs           = require('fs');
const path         = require('path');

const PROPS = [
  { label: '1-burbank',         address: '1012 N Sunset Canyon Dr, Burbank, CA 91504' },
  { label: '2-bassett',         address: '22150 Bassett St, Canoga Park, CA 91303' },
  { label: '3-north-hollywood', address: '6149 Auckland Ave, North Hollywood, CA 91606' },
];

const OUT = path.join(__dirname, 'test-screenshots', '3props');
fs.mkdirSync(OUT, { recursive: true });

function startServer() {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  return new Promise(resolve => {
    let log = '';
    srv.stdout.on('data', d => { log += d; if (log.includes('running at')) resolve(srv); });
    srv.stderr.on('data', d => { log += d; });
    setTimeout(() => resolve(srv), 4000);
  });
}

async function testProperty(page, prop, outDir) {
  console.log('\n──────────────────────────────────────────────────────');
  console.log('  Property: ' + prop.address);
  console.log('──────────────────────────────────────────────────────');

  await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });

  // Geocode address
  await page.fill('#addressInput', prop.address);
  await page.evaluate(addr => {
    const el = document.getElementById('addressInput');
    el.value = addr;
    el.dispatchEvent(new Event('change'));
  }, prop.address);
  await page.waitForFunction(() => window.__state?.latLng != null, { timeout: 10000 })
    .catch(() => null);

  const coords = await page.evaluate(() => ({
    lat: window.__state?.latLng?.lat(),
    lng: window.__state?.latLng?.lng(),
  }));
  console.log('  Geocoded: ' + coords.lat + ', ' + coords.lng);

  if (!coords.lat) {
    console.log('  ✗ Geocoding failed — skipping');
    await page.screenshot({ path: path.join(outDir, prop.label + '-FAILED.png') });
    return;
  }

  // Go to map
  await page.click('#startBtn');
  await page.waitForFunction(
    () => document.getElementById('step-2')?.classList.contains('active'),
    { timeout: 8000 }
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, prop.label + '-map.png') });
  console.log('  Map loaded');

  // Auto-detect
  await page.click('#autoDetectBtn');
  console.log('  Auto-detecting… (up to 45s)');
  await page.locator('#aiLoadingOverlay').waitFor({ state: 'hidden', timeout: 45000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, prop.label + '-detected.png') });

  const result = await page.evaluate(() => ({
    sqft:      window.__state?.sqft || 0,
    polyCount: (window.__state?.polygon ? 1 : 0) + (window.__state?.polygons?.length || 0),
    footer:    document.getElementById('mapFooterHint')?.textContent,
  }));

  console.log('  Polygons : ' + result.polyCount);
  console.log('  Sqft     : ' + result.sqft.toLocaleString() + ' sq ft');
  console.log('  Footer   : ' + result.footer);
  console.log('  Screenshot → ' + prop.label + '-detected.png');
}

(async () => {
  console.log('══════════════════════════════════════════════════════');
  console.log('  3-Property Lawn Detection Test');
  console.log('══════════════════════════════════════════════════════');

  const server  = await startServer();
  console.log('✓ Server started');

  const browser = await chromium.launch({ headless: true });

  for (const prop of PROPS) {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => console.log('  [page error]', e.message.slice(0, 80)));
    try {
      await testProperty(page, prop, OUT);
    } catch (err) {
      console.log('  ERROR: ' + err.message.slice(0, 120));
      await page.screenshot({ path: path.join(OUT, prop.label + '-ERROR.png') }).catch(() => {});
    }
    await page.close();
  }

  await browser.close();
  server.kill();

  console.log('\n══════════════════════════════════════════════════════');
  console.log('Done. Screenshots saved to: test-screenshots/3props/');
  console.log('  ' + PROPS.map(p => p.label + '-detected.png').join('\n  '));
  console.log('══════════════════════════════════════════════════════');
})();
