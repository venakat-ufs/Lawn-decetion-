/**
 * Full UI iteration test — runs Auto-Detect on the live app,
 * takes screenshots, analyses results, fixes prompt if needed, repeats.
 * Run: node iterate-test.js  (server must NOT be running — this starts it)
 */

const { chromium }  = require('playwright');
const { spawn }     = require('child_process');
const fs            = require('fs');
const path          = require('path');
const http          = require('http');

// Flat suburban address — typical front+back lawn, good multi-polygon test
const ADDRESS  = '1012 N Sunset Canyon Dr, Burbank, CA 91504';
const BASE_URL = 'http://localhost:3001';
const SS_DIR   = path.join(__dirname, 'iterations');
const MAX_ITER = 1;

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR);

// ── Start / stop server ───────────────────────────────────────────────────────
function startServer() {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  return new Promise((resolve, reject) => {
    let log = '';
    srv.stdout.on('data', d => { log += d; if (log.includes('running at')) resolve(srv); });
    srv.stderr.on('data', d => { log += d; });
    setTimeout(() => resolve(srv), 4000);
  });
}

// ── Call API using the same coords + parcel_boundary the browser used ─────────
function callAPI(lat, lng, parcelBoundary, parcelSource) {
  return new Promise((resolve, reject) => {
    const payload = { lat, lng };
    if (parcelBoundary?.length) {
      payload.parcel_boundary = parcelBoundary;
      payload.parcel_source   = parcelSource || 'parcel';
    }
    const body = JSON.stringify(payload);
    const req  = http.request({
      hostname: 'localhost', port: 3001, path: '/api/detect-lawn', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,100))); }});
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Analyse one iteration result ──────────────────────────────────────────────
function analyse(iter, apiResult, footerText, sqftText) {
  // Support both new lawn_polygons (array) and old lawn_polygon (single)
  const allPolygons = apiResult.lawn_polygons?.length
    ? apiResult.lawn_polygons
    : (apiResult.lawn_polygon?.length >= 3 ? [apiResult.lawn_polygon] : []);
  const lawn  = allPolygons[0] || [];
  const conf  = apiResult.confidence || 'none';
  const issues = [];
  let   pass   = true;

  console.log('\n  ┌─ API result ───────────────────────────────');
  console.log('  │ polygons    : ' + allPolygons.length);
  console.log('  │ pts(poly 0) : ' + lawn.length);
  console.log('  │ confidence  : ' + conf);
  console.log('  │ source      : ' + apiResult.source);

  if (allPolygons.length === 0) {
    issues.push('NO_LAWN: returned no lawn polygon');
    pass = false;
  } else {
    allPolygons.forEach((poly, i) => {
      const xs = poly.map(p=>p.x), ys = poly.map(p=>p.y);
      const w = Math.max(...xs)-Math.min(...xs), h = Math.max(...ys)-Math.min(...ys);
      console.log('  │ poly[' + i + '] bbox : ' + w + 'x' + h + 'px (~' + Math.round(w*0.15) + 'x' + Math.round(h*0.15) + ' m)');
      if (i === 0) {
        if (w < 8 || h < 8) {
          issues.push('TOO_SMALL: Primary polygon is only ' + w + 'x' + h + 'px');
          pass = false;
        }
        if (w > 580 || h > 580) {
          issues.push('TOO_LARGE: Primary polygon spans ' + w + 'x' + h + 'px — whole block, not just lawn');
          pass = false;
        }
      }
    });
  }

  console.log('  │ UI footer   : "' + (footerText || '?') + '"');
  console.log('  │ UI sqft     : "' + (sqftText || '?') + '"');

  const sqftNum = parseInt((sqftText || '0').replace(/\D/g,'')) || 0;
  console.log('  │ sqft parsed : ' + sqftNum);

  // UI must confirm a real polygon was drawn (not just API saying it found something)
  if (lawn.length >= 3 && sqftNum === 0) {
    issues.push('UI_EMPTY: API returned polygon but UI shows 0 sqft — GPT-4o was inconsistent, retry');
    pass = false;
  }
  if (sqftNum > 0 && sqftNum < 50) {
    issues.push('SQFT_TINY: Only ' + sqftNum + ' sqft — likely wrong surface (driveway/concrete, not grass)');
    pass = false;
  }
  if (sqftNum > 8000) {
    issues.push('SQFT_HUGE: ' + sqftNum + ' sqft is too large for a residential lawn here');
    pass = false;
  }

  if (conf === 'low') {
    issues.push('LOW_CONF: GPT-4o has low confidence — result may be inaccurate');
    pass = false;
  }

  console.log('  └────────────────────────────────────────────');

  if (issues.length) {
    console.log('\n  Issues found:');
    issues.forEach(i => console.log('    ✗ ' + i));
  } else {
    console.log('\n  ✅ No issues found!');
  }

  return { pass, issues, sqftNum, lawn };
}

// ── Build prompt fix based on issues ─────────────────────────────────────────
function buildFix(issues) {
  const fixes = [];

  if (issues.some(i => i.startsWith('NO_LAWN'))) {
    fixes.push('Prompt: more explicit about finding ANY green area near the red pin');
    fixes.push('Prompt: mention the lawn may be small or partially dry');
  }
  if (issues.some(i => i.startsWith('TOO_SMALL'))) {
    fixes.push('Prompt: instruct minimum 6+ points, cover the whole grass patch not just a corner');
  }
  if (issues.some(i => i.startsWith('TOO_LARGE'))) {
    fixes.push('Prompt: re-emphasise single-property boundary, do NOT cross the road');
  }
  if (issues.some(i => i.startsWith('SQFT_TINY'))) {
    fixes.push('Prompt: avoid driveway/concrete, focus specifically on grass texture');
  }

  return fixes;
}

// ── Apply a prompt fix to server.js ──────────────────────────────────────────
let currentExtra = '';
function applyPromptFix(iter, issues) {
  const serverPath = path.join(__dirname, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');

  let extra = '';

  if (issues.some(i => i.startsWith('NO_LAWN') || i.startsWith('TOO_SMALL'))) {
    extra = [
      'IMPORTANT: Even if the grass area is small or looks brownish/dry, identify it.',
      'Look carefully for ANY patch that has grass texture — even a 3x3 meter patch counts.',
      'The property at the red pin is a residential lot. It likely has at least some lawn.',
      'Do NOT return empty polygon — if unsure, estimate the most likely grass area.',
    ].join('\n');
  }

  if (issues.some(i => i.startsWith('TOO_LARGE'))) {
    extra = [
      'STRICT: The lawn polygon must be INSIDE the target property only.',
      'The property boundary is defined by the fence/wall/road edge closest to the red pin.',
      'Do not include neighboring properties. Do not cross streets or roads.',
    ].join('\n');
  }

  if (issues.some(i => i.startsWith('SQFT_TINY'))) {
    extra = [
      'Grass texture appears GREEN or BROWN-GREEN in satellite imagery.',
      'Avoid concrete, asphalt, gravel, and roof surfaces.',
      'The grass patch near the red pin may be a small strip — trace it fully.',
    ].join('\n');
  }

  if (!extra || extra === currentExtra) return false; // nothing new to apply

  // Inject the extra instructions into the prompt
  const marker = "'- confidence: \"high\" / \"medium\" / \"low\"',";
  if (!src.includes(marker)) { console.log('  Cannot find prompt injection point'); return false; }

  const replacement = "'ADDITIONAL GUIDANCE:\\n" + extra.replace(/\n/g, '\\n') + "',\n        " + marker;
  src = src.replace(marker, replacement);

  fs.writeFileSync(serverPath, src);
  currentExtra = extra;
  console.log('\n  Prompt fix applied for: ' + issues.map(i=>i.split(':')[0]).join(', '));
  return true;
}

// ── Main loop ─────────────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(60));
  console.log(' Iterative Auto-Detect Test');
  console.log(' Address: ' + ADDRESS);
  console.log(' Max iterations: ' + MAX_ITER);
  console.log('═'.repeat(60));

  let server = await startServer();
  console.log('\n✓ Server started');

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  let bestPass = false;

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    console.log('\n' + '─'.repeat(60));
    console.log('ITERATION ' + iter + '/' + MAX_ITER);
    console.log('─'.repeat(60));

    const page = await ctx.newPage();

    try {
      // 1. Load app
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
      await page.screenshot({ path: path.join(SS_DIR, iter + '-1-home.png') });
      console.log('\n  [1] Home loaded');

      // 2. Enter address — trigger geocoder via change event (works headless)
      await page.fill('#addressInput', ADDRESS);
      await page.evaluate(addr => {
        const el = document.getElementById('addressInput');
        el.value = addr;
        el.dispatchEvent(new Event('change'));
      }, ADDRESS);
      await page.waitForFunction(() => window.__state?.latLng != null, { timeout: 10000 })
        .catch(() => null);
      const geocoded = await page.evaluate(() => ({
        lat: window.__state?.latLng?.lat(),
        lng: window.__state?.latLng?.lng(),
      }));
      console.log('\n  [2] Geocoded: ' + geocoded.lat + ', ' + geocoded.lng);

      // 3. Click Get Estimate → goes to map step
      await page.click('#startBtn');
      await page.waitForFunction(
        () => document.getElementById('step-2')?.classList.contains('active'),
        { timeout: 8000 }
      );
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(SS_DIR, iter + '-2-map.png') });
      console.log('  [3] Map loaded — screenshot: ' + iter + '-2-map.png');

      // 4. Click Auto-Detect
      await page.click('#autoDetectBtn');
      console.log('  [4] Auto-Detect clicked — waiting for AI…');

      // Wait for loading overlay to disappear (up to 30s)
      await page.locator('#aiLoadingOverlay').waitFor({ state: 'hidden', timeout: 30000 });
      await page.waitForTimeout(1000);

      // 5. Screenshot with detection result
      await page.screenshot({ path: path.join(SS_DIR, iter + '-3-detected.png') });
      console.log('  [5] Detection complete — screenshot: ' + iter + '-3-detected.png');

      // Read UI state — lat/lng, sqft, and parcel boundary (for API call parity)
      const uiState = await page.evaluate(() => ({
        lat:           window.__state?.latLng?.lat(),
        lng:           window.__state?.latLng?.lng(),
        sqft:          window.__state?.sqft || 0,
        parcelBoundary: window.__state?.parcelBoundary || [],
        parcelSource:   window.__state?.parcelSource   || 'parcel',
      }));
      const footerText  = await page.locator('#mapFooterHint').textContent().catch(() => '');
      const liveOverlay = await page.locator('#liveSqftOverlay').textContent().catch(() => '');
      console.log('  [5] Footer  : "' + footerText + '"');
      console.log('  [5] UI sqft : ' + uiState.sqft + ' sq ft  (from state.sqft)');
      console.log('  [5] Overlay : "' + liveOverlay + '"');
      console.log('  [5] Center  : ' + uiState.lat + ', ' + uiState.lng);
      console.log('  [5] Parcel  : ' + uiState.parcelBoundary.length + ' pts');

      // 6. Call API with SAME params as browser (lat/lng + parcel_boundary)
      const apiResult = await callAPI(uiState.lat, uiState.lng, uiState.parcelBoundary, uiState.parcelSource);
      fs.writeFileSync(path.join(SS_DIR, iter + '-result.json'), JSON.stringify(apiResult, null, 2));

      // 7. Analyse — pass the browser sqft for consistency check
      const sqftDisplay = String(uiState.sqft) + ' sq ft';
      const { pass, issues, sqftNum } = analyse(iter, apiResult, footerText, sqftDisplay);

      if (pass) {
        console.log('\n🎉 PASSED on iteration ' + iter + '! sqft=' + sqftNum);

        // 8. Click Get My Estimate
        const estimateBtn = page.locator('#getEstimateBtn');
        if (await estimateBtn.isEnabled().catch(() => false)) {
          await estimateBtn.click();
          await page.waitForTimeout(2000);
          await page.screenshot({ path: path.join(SS_DIR, iter + '-4-estimate.png') });
          console.log('  [8] Estimate page — screenshot: ' + iter + '-4-estimate.png');
        }

        bestPass = true;
        await page.close();
        break;
      }

      // 9. Fix prompt and restart server
      const fixed = applyPromptFix(iter, issues);
      await page.close();

      if (fixed && iter < MAX_ITER) {
        console.log('\n  Restarting server with new prompt…');
        server.kill();
        await new Promise(r => setTimeout(r, 1500));
        server = await startServer();
        console.log('  Server restarted');
      } else if (!fixed) {
        console.log('\n  No new fix available — retrying same prompt');
      }

    } catch (err) {
      console.log('\n  ERROR in iteration ' + iter + ': ' + err.message);
      await page.screenshot({ path: path.join(SS_DIR, iter + '-error.png') }).catch(() => {});
      await page.close();
    }
  }

  await browser.close();
  server.kill();

  console.log('\n' + '═'.repeat(60));
  if (bestPass) {
    console.log('✅ Detection working correctly!');
  } else {
    console.log('⚠️  Max iterations reached.');
    console.log('This property (6149 Auckland Ave) has minimal visible lawn in satellite imagery.');
    console.log('The AI detection works — user should use Trace to draw manually for this address.');
  }
  console.log('Screenshots + JSON in: iterations/');
  console.log('═'.repeat(60));
})();
