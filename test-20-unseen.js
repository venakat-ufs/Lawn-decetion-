/**
 * 20-case unseen regression test for lawn detection.
 *
 * Generates one screenshot per case plus a JSON summary of the detector output.
 * Run: node test-20-unseen.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'test-screenshots', 'unseen-20');
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { label: '01-nh-new-1', address: 'North Hollywood unseen 1', lat: 34.1609, lng: -118.3722 },
  { label: '02-vv-new-2', address: 'Valley Village unseen 2', lat: 34.1668, lng: -118.3867 },
  { label: '03-toluca-new-3', address: 'Toluca Lake unseen 3', lat: 34.1889, lng: -118.3315 },
  { label: '04-studio-new-4', address: 'Studio City unseen 4', lat: 34.1416, lng: -118.3842 },
  { label: '05-so-new-5', address: 'Sherman Oaks unseen 5', lat: 34.1539, lng: -118.4306 },
  { label: '06-burbank-new-6', address: 'Burbank unseen 6', lat: 34.2051, lng: -118.2942 },
  { label: '07-canoga-new-7', address: 'Canoga Park unseen 7', lat: 34.1968, lng: -118.5715 },
  { label: '08-pasadena-new-8', address: 'South Pasadena unseen 8', lat: 34.1238, lng: -118.1548 },
  { label: '09-burbank-nl-9', address: 'Burbank no-lawn 9', lat: 34.1786, lng: -118.2991 },
  { label: '10-vn-nl-10', address: 'Van Nuys no-lawn 10', lat: 34.1869, lng: -118.4509 },
  { label: '11-glendale-nl-11', address: 'Glendale no-lawn 11', lat: 34.1483, lng: -118.2505 },
  { label: '12-hollywood-nl-12', address: 'Hollywood no-lawn 12', lat: 34.0992, lng: -118.3308 },
  { label: '13-burbank-new-13', address: 'Burbank unseen 13', lat: 34.2121, lng: -118.3728 },
  { label: '14-encino-new-14', address: 'Encino unseen 14', lat: 34.1679, lng: -118.4150 },
  { label: '15-pasadena-new-15', address: 'Pasadena unseen 15', lat: 34.1307, lng: -118.1338 },
  { label: '16-vn-nl-16', address: 'Van Nuys no-lawn 16', lat: 34.1750, lng: -118.4780 },
  { label: '17-studio-new-17', address: 'Studio City unseen 17', lat: 34.1542, lng: -118.4095 },
  { label: '18-canoga-new-18', address: 'Canoga Park unseen 18', lat: 34.1950, lng: -118.6000 },
  { label: '19-so-nl-19', address: 'Sherman Oaks no-lawn 19', lat: 34.1602, lng: -118.5005 },
  { label: '20-hills-nl-20', address: 'Hollywood Hills no-lawn 20', lat: 34.1387, lng: -118.3602 },
];

function startServer() {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  return new Promise(resolve => {
    let log = '';
    srv.stdout.on('data', d => {
      log += d;
      if (log.includes('running at')) resolve(srv);
    });
    srv.stderr.on('data', d => { log += d; });
    setTimeout(() => resolve(srv), 5000);
  });
}

async function waitMapReady(page) {
  await page.waitForFunction(
    () => typeof google !== 'undefined'
      && typeof google.maps !== 'undefined'
      && window.__state?.map != null,
    { timeout: 25000 }
  );
}

async function runCase(page, c, idx) {
  console.log('\nCase ' + (idx + 1) + '/20: ' + c.label);
  console.log('  coords : ' + c.lat + ', ' + c.lng);

  await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 20000 });
  await waitMapReady(page);

  await page.evaluate(({ lat, lng, address }) => {
    const s = window.__state;
    s.latLng = new google.maps.LatLng(lat, lng);
    s.address = address;
    s.parcelBoundary = null;
    s.parcelSource = null;
    const input = document.getElementById('addressInput');
    if (input) input.value = address;
  }, { lat: c.lat, lng: c.lng, address: c.address });

  await page.click('#startBtn');
  await page.waitForFunction(
    () => document.getElementById('step-2')?.classList.contains('active'),
    { timeout: 8000 }
  );
  await page.waitForTimeout(1800);

  await page.click('#autoDetectBtn');
  await page.locator('#aiLoadingOverlay').waitFor({ state: 'hidden', timeout: 60000 });
  await page.waitForTimeout(900);

  const shot = path.join(OUT, String(idx + 1).padStart(2, '0') + '-' + c.label + '-detected.png');
  await page.screenshot({ path: shot });

  const result = await page.evaluate(() => ({
    sqft: window.__state?.sqft || 0,
    polyCount: (window.__state?.polygon ? 1 : 0) + (window.__state?.polygons?.length || 0),
    source: document.getElementById('mapFooterHint')?.textContent || '',
  }));

  console.log('  polygons: ' + result.polyCount);
  console.log('  sqft    : ' + result.sqft.toLocaleString());
  console.log('  source  : ' + result.source);
  console.log('  screenshot → ' + path.basename(shot));

  return { ...c, ...result, screenshot: shot };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  20-Case Unseen Lawn Detection Review Set');
  console.log('══════════════════════════════════════════════════════');

  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', err => console.log('  [page error]', err.message));
  page.on('dialog', dlg => { dlg.accept(); });

  const results = [];
  try {
    for (let i = 0; i < CASES.length; i += 1) {
      results.push(await runCase(page, CASES[i], i));
    }
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }

  const summaryPath = path.join(OUT, 'results.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  console.log('\n══════════════════════════════════════════════════════');
  console.log('Completed 20 / 20 cases');
  console.log('Screenshots saved to: ' + OUT);
  console.log('Summary saved to: ' + summaryPath);
  console.log('══════════════════════════════════════════════════════');
})().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
