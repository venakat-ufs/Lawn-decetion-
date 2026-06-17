/**
 * Batch detection test — hits local /api/detect-lawn for multiple addresses
 * Run: node test-batch.js
 */

const ADDRESSES = [
  { label: 'Burbank - Sunset Canyon (hillside)',   lat: 34.19941, lng: -118.30581 },
  { label: 'Burbank - N Frederic St (brown dirt)', lat: 34.18010, lng: -118.37556 },
  { label: 'North Hollywood - Auckland Ave',       lat: 34.18275, lng: -118.36080 },
  { label: 'Valley Village - Radford Ave',         lat: 34.17142, lng: -118.39242 },
  { label: 'Studio City - Laurelwood',             lat: 34.14450, lng: -118.39900 },
  { label: 'Van Nuys - Residential',               lat: 34.18650, lng: -118.44900 },
  { label: 'Burbank - Magnolia Park',              lat: 34.17800, lng: -118.31500 },
  { label: 'Sherman Oaks - Ventura',               lat: 34.15800, lng: -118.44900 },
  { label: 'Glendale - Residential',               lat: 34.14800, lng: -118.25500 },
  { label: 'Pasadena - Oak Knoll',                 lat: 34.13500, lng: -118.13200 },
];

const API = 'http://localhost:3001/api/detect-lawn';

async function testOne(addr) {
  const start = Date.now();
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: addr.lat, lng: addr.lng }),
    });
    const data = await res.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const sqft   = data.lawn_polygons?.reduce((s, p) => s + polyArea(p), 0) || 0;
    const parcel = data.parcel_boundary?.length ? 'yes' : 'no';
    const nPoly  = data.lawn_polygons?.length || 0;
    const src    = data.source || '?';

    return { label: addr.label, sqft: Math.round(sqft), nPoly, parcel, src, elapsed, ok: true };
  } catch (err) {
    return { label: addr.label, sqft: 0, nPoly: 0, parcel: '?', src: 'error', elapsed: '?', ok: false, err: err.message };
  }
}

function polyArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = typeof pts[i] === 'object' ? pts[i].x : 0;
    const yi = typeof pts[i] === 'object' ? pts[i].y : 0;
    const xj = typeof pts[j] === 'object' ? pts[j].x : 0;
    const yj = typeof pts[j] === 'object' ? pts[j].y : 0;
    area += (xj + xi) * (yj - yi);
  }
  return Math.abs(area / 2) * 0.1656;
}

(async () => {
  console.log('\n=== Batch Detection Test ===\n');
  console.log('Address'.padEnd(42) + 'Sqft'.padStart(8) + 'Polys'.padStart(6) + 'Parcel'.padStart(8) + 'Source'.padStart(22) + 'Time'.padStart(7));
  console.log('─'.repeat(93));

  for (const addr of ADDRESSES) {
    process.stdout.write(addr.label.padEnd(42));
    const r = await testOne(addr);
    const sqftStr = r.sqft ? r.sqft + ' ft²' : 'none';
    const flag = !r.sqft ? ' ⚠️' : r.sqft > 5000 ? ' 🔴' : r.sqft > 2000 ? ' 🟡' : ' ✅';
    console.log(
      sqftStr.padStart(8) +
      String(r.nPoly).padStart(6) +
      r.parcel.padStart(8) +
      r.src.padStart(22) +
      (r.elapsed + 's').padStart(7) +
      flag
    );
    // small delay to avoid hammering the API
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\nLegend: ✅ reasonable  🟡 large (>2000 sqft, check)  🔴 too large (>5000)  ⚠️ nothing detected');
  console.log('\nFull logs: detection.log\n');
})();
