/**
 * 30-case residential lawn review set.
 *
 * Positive-only suite built from verified lawn detections and nearby
 * follow-up houses that also produced positive results.
 *
 * Run: node test-30-houses.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'test-screenshots', 'houses-30');
fs.mkdirSync(OUT, { recursive: true });

const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH
  || (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

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
  { label: '15-canoga-west', lat: 34.1950, lng: -118.6000, note: 'Canoga Park lawn' },
  { label: '16-burbank-nearby', lat: 34.1996, lng: -118.3063, note: 'Burbank lawn' },
  { label: '17-burbank-nearby-2', lat: 34.2007, lng: -118.3052, note: 'Burbank lawn' },
  { label: '18-vv-nearby', lat: 34.1720, lng: -118.3912, note: 'Valley Village lawn' },
  { label: '19-burbank-closer', lat: 34.2004, lng: -118.3052, note: 'Burbank lawn nearby' },
  { label: '20-burbank-east', lat: 34.2007, lng: -118.3059, note: 'Burbank lawn nearby' },
  { label: '21-burbank-west', lat: 34.1998, lng: -118.3049, note: 'Burbank lawn nearby' },
  { label: '22-burbank-south', lat: 34.1989, lng: -118.3066, note: 'Burbank lawn nearby' },
  { label: '23-noho-nearby', lat: 34.1832, lng: -118.3602, note: 'North Hollywood lawn nearby' },
  { label: '24-noho-alt', lat: 34.1822, lng: -118.3615, note: 'North Hollywood lawn nearby' },
  { label: '25-pasadena-nearby', lat: 34.1349, lng: -118.1312, note: 'Pasadena lawn nearby' },
  { label: '26-vv-east', lat: 34.1719, lng: -118.3918, note: 'Valley Village lawn nearby' },
  { label: '27-encino-nearby', lat: 34.1676, lng: -118.4144, note: 'Encino lawn nearby' },
  { label: '28-studio-east', lat: 34.1454, lng: -118.3982, note: 'Studio City lawn nearby' },
  { label: '29-canoga-east', lat: 34.1958, lng: -118.6090, note: 'Canoga Park lawn nearby' },
  { label: '30-canoga-west', lat: 34.1948, lng: -118.6102, note: 'Canoga Park lawn nearby' },
];

function startServer() {
  if (process.env.NO_START_SERVER === '1') {
    return Promise.resolve(null);
  }
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
  console.log('\nCase ' + (idx + 1) + '/30: ' + c.label);
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
  console.log('  30-Case Residential Lawn Review Set');
  console.log('══════════════════════════════════════════════════════');

  const server = await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
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
    if (server) server.kill();
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





