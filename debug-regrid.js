/**
 * Run: node debug-regrid.js
 * Tries every known Regrid endpoint to find what works.
 */

const fs = require('fs');
const path = require('path');

// Load .env
fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
  .split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length) process.env[k] = v.join('=').trim();
  });

const TOKEN = process.env.REGRID_API_KEY;
const LAT   = 34.18824;
const LNG   = -118.39378;
const ADDR  = '6149 Auckland Ave, North Hollywood, CA 91606';

async function tryUrl(label, url, opts = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        ...opts.headers,
      },
      ...opts,
    });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    const preview = text.slice(0, 300).replace(/\s+/g, ' ');
    console.log('\n[' + res.status + '] ' + label);
    console.log('  CT: ' + ct);
    console.log('  Body: ' + preview);
    return { status: res.status, body: text, ok: res.ok };
  } catch (e) {
    console.log('\n[ERR] ' + label + ' — ' + e.message);
    return null;
  }
}

(async () => {
  console.log('Regrid API debug — token starts:', TOKEN.slice(0, 20) + '...');
  console.log('Coords:', LAT, LNG, '\n');

  // v1 lat/lon with token in query
  await tryUrl('v1 /query lat/lon (token in query)', `https://app.regrid.com/api/v1/query?lat=${LAT}&lon=${LNG}&token=${TOKEN}`);
  await tryUrl('v1 /query lat/lon (bearer only)', `https://app.regrid.com/api/v1/query?lat=${LAT}&lon=${LNG}`);

  // Different coord precision
  await tryUrl('v1 /query 4 decimal places', `https://app.regrid.com/api/v1/query?lat=34.1882&lon=-118.3938&token=${TOKEN}`);
  await tryUrl('v1 /query 2 decimal places', `https://app.regrid.com/api/v1/query?lat=34.19&lon=-118.39&token=${TOKEN}`);

  // Typeahead
  const q = encodeURIComponent(ADDR);
  await tryUrl('v1 typeahead full address', `https://app.regrid.com/api/v1/typeahead.json?query=${q}&token=${TOKEN}`);
  await tryUrl('v1 typeahead short', `https://app.regrid.com/api/v1/typeahead.json?query=6149+Auckland&token=${TOKEN}`);

  // v2 variants
  await tryUrl('v2 /parcel lat/lon', `https://app.regrid.com/api/v2/parcel?lat=${LAT}&lon=${LNG}&token=${TOKEN}`);
  await tryUrl('v2 /parcel/query', `https://app.regrid.com/api/v2/parcel/query?lat=${LAT}&lon=${LNG}&token=${TOKEN}`);

  // With path param
  await tryUrl('v1 /parcel path us/ca', `https://app.regrid.com/api/v1/parcel?path=/us/ca&lat=${LAT}&lon=${LNG}&token=${TOKEN}`);

  // Matched address endpoint
  await tryUrl('v1 matched_addresses', `https://app.regrid.com/api/v1/matched_addresses?query=${q}&token=${TOKEN}`);

  // Check token info
  await tryUrl('token info / whoami', `https://app.regrid.com/api/v1/me?token=${TOKEN}`);
  await tryUrl('API root', `https://app.regrid.com/api/v1?token=${TOKEN}`);

})();
