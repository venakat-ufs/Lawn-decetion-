/**
 * 20-case residential lawn review set.
 *
 * All cases are chosen from residential-looking coordinates that have
 * already produced lawn detections in prior runs, so the set is intended
 * to be positive-only. Each screenshot captures the detector output.
 *
 * Run: node test-20-houses.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'test-screenshots', 'houses-20');
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { label: '01-burbank-sunset', lat: 34.1994095, lng: -118.3058051, note: 'Burbank lawn' },
  { label: '02-noho-auckland', lat: 34.1827537, lng: -118.3608, note: 'North Hollywood lawn' },
  { label: '03-vv-radford', lat: 34.17142, lng: -118.39242, note: 'Valley Village lawn' },
  { label: '04-studio-laurelwood', lat: 34.1445, lng: -118.399, note: 'Studio City lawn' },
  { label: '05-sherman-ventura', lat: 34.158, lng: -118.449, note: 'Sherman Oaks lawn' },
  { label: '06-canoga-bassett', lat: 34.1954062, lng: -118.6096622, note: 'Canoga Park lawn' },
  { label: '07-burbank-variant', lat: 34.2001, lng: -118.3048, note: 'Burbank lawn' },
  { label: '08-pasadena-oakknoll', lat: 34.1346, lng: -118.1316, note: 'Pasadena lawn' },
  { label: '09-studio-hill', lat: 34.1416, lng: -118.3842, note: 'Studio City lawn' },
  { label: '10-sherman-sideyard', lat: 34.1539, lng: -118.4306, note: 'Sherman Oaks lawn' },
  { label: '11-pasadena-front', lat: 34.1238, lng: -118.1548, note: 'Pasadena lawn' },
  { label: '12-burbank-residential', lat: 34.1786, lng: -118.2991, note: 'Burbank lawn' },
  { label: '13-glendale-yard', lat: 34.1483, lng: -118.2505, note: 'Glendale lawn' },
  { label: '14-encino-yard', lat: 34.1679, lng: -118.4150, note: 'Encino lawn' },
  { label: '15-studio-deeper', lat: 34.1542, lng: -118.4095, note: 'Studio City lawn' },
  { label: '16-canoga-west', lat: 34.1950, lng: -118.6000, note: 'Canoga Park lawn' },
  { label: '17-burbank-nearby', lat: 34.1996, lng: -118.3063, note: 'Burbank lawn' },
  { label: '18-burbank-nearby-2', lat: 34.2007, lng: -118.3052, note: 'Burbank lawn' },
  { label: '19-sherman-nearby', lat: 34.1571, lng: -118.4512, note: 'Sherman Oaks lawn' },
  { label: '20-vv-nearby', lat: 34.1720, lng: -118.3912, note: 'Valley Village lawn' },
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

async function reverseGeocode(page, lat, lng, fallback) {
  return page.evaluate(({ lat, lng, fallback }) => {
    return new Promise(resolve => {
      try {
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat, lng } }, (results, status) => {
          if (status === 'OK' && results && results[0] && results[0].formatted_address) {
            resolve(results[0].formatted_address);
          } else {
            resolve(fallback);
          }
        });
      } catch (err) {
        resolve(fallback);
      }
    });
  }, { lat, lng, fallback });
}

async function runCase(page, c, idx) {
  console.log('\nCase ' + (idx + 1) + '/20: ' + c.label);
  console.log('  coords : ' + c.lat + ', ' + c.lng);

  await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 20000 });
  await waitMapReady(page);

  const address = await reverseGeocode(page, c.lat, c.lng, c.note);
  console.log('  addr   : ' + address);

  await page.evaluate(({ lat, lng, address }) => {
    const s = window.__state;
    s.latLng = new google.maps.LatLng(lat, lng);
    s.address = address;
    s.parcelBoundary = null;
    s.parcelSource = null;
    const input = document.getElementById('addressInput');
    if (input) input.value = address;
  }, { lat: c.lat, lng: c.lng, address });

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

  return { ...c, address, ...result, screenshot: shot };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  20-Case Residential Lawn Review Set');
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

  const detected = results.filter(r => r.polyCount > 0);
  console.log('\n══════════════════════════════════════════════════════');
  console.log('Completed ' + results.length + ' / ' + CASES.length + ' cases');
  console.log('Detected lawns : ' + detected.length);
  console.log('No-grass cases  : ' + (results.length - detected.length));
  console.log('Screenshots saved to: ' + OUT);
  console.log('Summary saved to: ' + summaryPath);
  console.log('══════════════════════════════════════════════════════');
})().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
