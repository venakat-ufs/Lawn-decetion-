/**
 * Playwright recursive detection tester
 * Usage: node test-detection.js   (server must be running: node server.js)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const BASE_URL = 'http://localhost:3001';
const ADDRESS  = '6149 Auckland Ave, North Hollywood, CA 91606';
const LAT      = 34.18824;
const LNG      = -118.39378;
const MAX      = 3;
const SS_DIR   = path.join(__dirname, 'test-screenshots');

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR);

function callAPI() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ lat: LAT, lng: LNG });
    const req  = http.request({
      hostname: 'localhost', port: 3001, path: '/api/detect-lawn', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON: ' + body.slice(0,100))); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function score(r) {
  const issues = [], lawn = r.lawn_polygon || [];
  let pts = 0;

  issues.push('source     : ' + r.source);
  issues.push('confidence : ' + r.confidence);
  issues.push('lawn points: ' + lawn.length);

  if (lawn.length >= 3) {
    pts += 50;
    const xs = lawn.map(p => p.x), ys = lawn.map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    issues.push('lawn size  : ' + w + 'x' + h + 'px (~' + Math.round(w*0.06) + 'x' + Math.round(h*0.06) + 'm)');
    if (w > 10 && h > 10 && w < 580 && h < 580) pts += 30;
    else issues.push('WARN: size out of range');
  } else {
    issues.push('FAIL: no lawn polygon returned');
  }
  if (r.confidence === 'high') pts += 20;
  else if (r.confidence === 'medium') pts += 10;

  return { pts, issues };
}

async function round(browser, n) {
  console.log('\n── Round ' + n + ' ──────────────────────────────────────');

  const page = await browser.newPage();
  try {
    await page.goto(BASE_URL, { timeout: 10000 });
    await page.screenshot({ path: path.join(SS_DIR, 'r' + n + '-landing.png') });

    // Enter address
    await page.fill('#addressInput', ADDRESS);
    await page.waitForTimeout(1200);
    const suggestion = page.locator('.pac-item').first();
    if (await suggestion.isVisible({ timeout: 2000 }).catch(() => false)) await suggestion.click();
    await page.click('#startBtn');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SS_DIR, 'r' + n + '-map.png') });
    console.log('  Screenshots saved: r' + n + '-landing.png, r' + n + '-map.png');
  } catch(e) {
    console.log('  Browser nav error: ' + e.message);
  } finally { await page.close(); }

  console.log('  Calling /api/detect-lawn…');
  let result;
  try { result = await callAPI(); }
  catch(e) { console.log('  ERROR: ' + e.message + '\n  Is server running? node server.js'); return null; }

  fs.writeFileSync(path.join(SS_DIR, 'r' + n + '-result.json'), JSON.stringify(result, null, 2));

  const { pts, issues } = score(result);
  console.log('  Score: ' + pts + '/100');
  issues.forEach(i => console.log('    ' + i));
  return { pts, result };
}

(async () => {
  console.log('\n🧪 Lawn Detection Test — ' + ADDRESS);
  const browser = await chromium.launch({ headless: true }).catch(e => {
    console.log('Chromium not found. Run: npx playwright install chromium'); process.exit(1);
  });

  let best = { pts: 0 };
  for (let n = 1; n <= MAX; n++) {
    const res = await round(browser, n);
    if (!res) break;
    if (res.pts > best.pts) best = res;
    if (res.pts >= 70) { console.log('\n✅ Passed (' + res.pts + '/100)'); break; }
    if (n < MAX) { console.log('\n  Retrying in 4s…'); await new Promise(r => setTimeout(r, 4000)); }
  }

  await browser.close();
  console.log('\n══ Best: ' + best.pts + '/100 ═══════════════════════════════');
  if ((best.result?.lawn_polygon || []).length === 0) {
    console.log('Lawn not detected. Possible reasons:');
    console.log('  1. This property has minimal/dry grass in the satellite image');
    console.log('  2. Try a different address with a visible green lawn');
    console.log('  3. User can trace manually using the Trace tool');
  }
  console.log('Results in: test-screenshots/');
})();
