/**
 * Multi-case Playwright regression test for lawn detection.
 *
 * Uses direct coordinates for a broader sample set so we can check
 * accuracy and screenshot output without relying on address geocoding.
 *
 * Run: node test-more-cases.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'test-screenshots', 'more-cases');
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  {
    label: 'sherman-oaks-false-positive-watch',
    address: '5643 Colbath Ave, Sherman Oaks, CA 91401',
    lat: 34.1734522,
    lng: -118.4370093,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'burbank-hillside',
    address: '1012 N Sunset Canyon Dr, Burbank, CA 91504',
    lat: 34.1994095,
    lng: -118.3058051,
    minSqft: 200,
    minPolys: 1,
  },
  {
    label: 'north-hollywood-auckland',
    address: '6149 Auckland Ave, North Hollywood, CA 91606',
    lat: 34.1827537,
    lng: -118.3608,
    minSqft: 200,
    minPolys: 1,
  },
  {
    label: 'valley-village-radford',
    address: 'Valley Village / Radford Ave',
    lat: 34.17142,
    lng: -118.39242,
    minSqft: 800,
    minPolys: 2,
  },
  {
    label: 'studio-city-laurelwood',
    address: 'Studio City / Laurelwood',
    lat: 34.1445,
    lng: -118.399,
    minSqft: 100,
    minPolys: 1,
  },
  {
    label: 'van-nuys-residential',
    address: 'Van Nuys / Residential',
    lat: 34.1865,
    lng: -118.449,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'burbank-brown-dirt',
    address: 'Burbank / N Frederic St',
    lat: 34.1801,
    lng: -118.37556,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'burbank-magnolia-park',
    address: 'Burbank / Magnolia Park',
    lat: 34.178,
    lng: -118.315,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'sherman-ventura',
    address: 'Sherman Oaks / Ventura Blvd',
    lat: 34.158,
    lng: -118.449,
    minSqft: 100,
    minPolys: 1,
  },
  {
    label: 'glendale-residential',
    address: 'Glendale / Residential',
    lat: 34.148,
    lng: -118.255,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'pasadena-oak-knoll',
    address: 'Pasadena / Oak Knoll',
    lat: 34.135,
    lng: -118.132,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'canoga-bassett',
    address: '22150 Bassett St, Canoga Park, CA 91303',
    lat: 34.1954062,
    lng: -118.6096622,
    minSqft: 1000,
    minPolys: 2,
  },
  {
    label: 'burbank-sunset-variant',
    address: 'Burbank / Sunset Canyon (variant)',
    lat: 34.2001,
    lng: -118.3048,
    minSqft: 500,
    minPolys: 1,
  },
  {
    label: 'van-nuys-variant',
    address: 'Van Nuys / Residential (variant)',
    lat: 34.1865,
    lng: -118.449,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'glendale-variant',
    address: 'Glendale / Residential (variant)',
    lat: 34.148,
    lng: -118.255,
    maxSqft: 100,
    maxPolys: 0,
  },
  {
    label: 'pasadena-variant',
    address: 'Pasadena / Oak Knoll (variant)',
    lat: 34.1346,
    lng: -118.1316,
    minSqft: 50,
    minPolys: 1,
  },
];

function startServer() {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  return new Promise(resolve => {
    let log = '';
    srv.stdout.on('data', d => {
      log += d;
      if (log.includes('running at')) resolve(srv);
    });
    srv.stderr.on('data', d => {
      log += d;
    });
    setTimeout(() => resolve(srv), 4000);
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
  console.log('\nCase ' + (idx + 1) + ': ' + c.label);
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
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, c.label + '-map.png') });

  await page.click('#autoDetectBtn');
  await page.locator('#aiLoadingOverlay').waitFor({ state: 'hidden', timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, c.label + '-detected.png') });

  const result = await page.evaluate(() => ({
    sqft: window.__state?.sqft || 0,
    polyCount: (window.__state?.polygon ? 1 : 0) + (window.__state?.polygons?.length || 0),
    source: document.getElementById('mapFooterHint')?.textContent || '',
  }));

  const sqftOk = typeof c.minSqft === 'number' ? result.sqft >= c.minSqft : true;
  const sqftTooHigh = typeof c.maxSqft === 'number' ? result.sqft <= c.maxSqft : true;
  const polyOk = typeof c.minPolys === 'number' ? result.polyCount >= c.minPolys : true;
  const polyTooHigh = typeof c.maxPolys === 'number' ? result.polyCount <= c.maxPolys : true;
  const pass = sqftOk && sqftTooHigh && polyOk && polyTooHigh;

  console.log('  polygons: ' + result.polyCount);
  console.log('  sqft    : ' + result.sqft.toLocaleString());
  console.log('  footer  : ' + result.source);
  console.log('  status  : ' + (pass ? 'PASS' : 'FLAG'));

  return { ...result, pass };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Multi-case Lawn Detection Regression Test');
  console.log('══════════════════════════════════════════════════════');

  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  page.on('pageerror', err => console.log('  [page error]', err.message));
  page.on('dialog', dlg => { console.log('  [alert]', dlg.message()); dlg.accept(); });

  const results = [];
  try {
    for (let i = 0; i < CASES.length; i += 1) {
      results.push(await runCase(page, CASES[i], i));
    }
  } catch (err) {
    console.error('\nTest run failed:', err.message);
  } finally {
    await browser.close();
    server.kill();
  }

  const passed = results.filter(r => r.pass).length;
  console.log('\n══════════════════════════════════════════════════════');
  console.log('Summary: ' + passed + '/' + results.length + ' cases within expected ranges');
  results.forEach((r, i) => {
    console.log(
      '  ' + CASES[i].label.padEnd(30) +
      ' sqft=' + String(r.sqft).padStart(4) +
      ' polys=' + String(r.polyCount).padStart(2) +
      ' ' + (r.pass ? 'OK' : 'FLAG')
    );
  });
  const accuracy = results.length ? Math.round((passed / results.length) * 100) : 0;
  console.log('Heuristic accuracy: ' + accuracy + '%');
  console.log('Screenshots saved to: ' + OUT);
  console.log('══════════════════════════════════════════════════════');
})();
