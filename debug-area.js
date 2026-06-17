/**
 * Mirrors app.js pixelToLatLng + computeArea logic in Node.js
 * to verify whether 101 sq ft is correct for the Burbank result.
 */

const result = require('./iterations/1-result.json');

const LAT = 34.1994095;
const LNG = -118.3058051;
const STATIC_ZOOM = 20;
const STATIC_MAP_SIZE = 640;

// Exact copy of app.js pixelToLatLng
function pixelToLatLng(px, py, centerLat, centerLng, zoom, imgSize) {
  const half  = imgSize / 2;
  const scale = Math.pow(2, zoom);
  const worldX = ((centerLng + 180) / 360) * 256 * scale;
  const sinLat = Math.sin(centerLat * Math.PI / 180);
  const worldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 256 * scale;
  const targetX = worldX + (px - half);
  const targetY = worldY + (py - half);
  const lng = targetX / (256 * scale) * 360 - 180;
  const n   = Math.PI - 2 * Math.PI * targetY / (256 * scale);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

// Shoelace formula in lat/lng space (approx sq meters)
function computeAreaSqFt(latLngPath) {
  // Use Haversine-based area formula (same as Google Maps Geometry library)
  const R = 6378137; // Earth radius in meters
  const n = latLngPath.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p1 = latLngPath[i];
    const p2 = latLngPath[(i + 1) % n];
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    area += dLng * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  area = Math.abs(area * R * R / 2);
  return Math.round(area * 10.7639);
}

// Pixel-based area using shoelace
function pixelAreaSqFt(pixels) {
  const n = pixels.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p1 = pixels[i];
    const p2 = pixels[(i + 1) % n];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  const pixArea = Math.abs(area) / 2;
  // At zoom 20, lat 34°: resolution ≈ 0.1238 m/px
  const mPerPx = (2 * Math.PI * 6378137 * Math.cos(LAT * Math.PI / 180)) / (256 * Math.pow(2, STATIC_ZOOM));
  const sqm = pixArea * mPerPx * mPerPx;
  return { pixArea, mPerPx, sqm, sqft: Math.round(sqm * 10.7639) };
}

const allPolygons = result.lawn_polygons;

console.log('\n=== DEBUG: Pixel → LatLng area check ===\n');
console.log('Center:', LAT, LNG);
console.log('Zoom:', STATIC_ZOOM, '  ImageSize:', STATIC_MAP_SIZE, 'px');

let totalSqFt = 0;

allPolygons.forEach((poly, i) => {
  const latLngPath = poly.map(pt => pixelToLatLng(pt.x, pt.y, LAT, LNG, STATIC_ZOOM, STATIC_MAP_SIZE));
  const sqft = computeAreaSqFt(latLngPath);
  totalSqFt += sqft;

  const pixInfo = pixelAreaSqFt(poly);

  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);

  console.log(`Polygon ${i}:`);
  console.log(`  Pixel bbox: ${w}×${h}px`);
  console.log(`  Pixel area: ${Math.round(pixInfo.pixArea)} px²`);
  console.log(`  m/px at lat ${LAT}: ${pixInfo.mPerPx.toFixed(4)}`);
  console.log(`  Expected area (pixel approx): ~${pixInfo.sqft} sq ft (${Math.round(pixInfo.sqm)} sq m)`);
  console.log(`  Converted LatLng[0]: ${JSON.stringify(latLngPath[0])}`);
  console.log(`  Converted LatLng[last]: ${JSON.stringify(latLngPath[latLngPath.length - 1])}`);
  console.log(`  computeArea result: ${sqft} sq ft`);
  console.log();
});

console.log(`Total computed sqft: ${totalSqFt}`);
console.log('\nExpected from UI test: 101 sq ft');
console.log('\nConclusion:');
if (Math.abs(totalSqFt - 101) < 20) {
  console.log('  ✓ Matches UI — conversion is correct, but polygon is genuinely tiny');
} else if (totalSqFt > 500) {
  console.log('  ✗ BIG MISMATCH — pixel coords produce ' + totalSqFt + ' sq ft but UI showed 101');
  console.log('  → Bug in rendering or the UI used a different API result');
} else {
  console.log('  ? Partial mismatch — further investigation needed');
}
