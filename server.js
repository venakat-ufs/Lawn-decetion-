/**
 * Local dev server for UFS Lawn Mowing Ad
 * Reads .env, serves static files + /api/* routes
 * Run: node server.js
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const [key, ...rest] = line.trim().split('=');
      if (key && rest.length) process.env[key] = rest.join('=').trim();
    });
}

const PORT         = 3001;
const MAPS_KEY     = process.env.GOOGLE_MAPS_API_KEY || '';
const OPENAI_KEY   = process.env.OPENAI_API_KEY || '';
const REGRID_KEY   = process.env.REGRID_API_KEY || '';
const STATIC_SIZE  = 640;
const STATIC_ZOOM  = 20;   // zoom 20 = tighter lot-level view for lawn detection

// ── Detection logger ─────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'detection.log');
function dlog(tag, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tag, ...data });
  console.log('[' + tag + ']', JSON.stringify(data));
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Coordinate helpers ────────────────────────────────────────────────────────
function latLngToPixel(pointLat, pointLng, centerLat, centerLng, zoom, imgSize) {
  const half  = imgSize / 2;
  const scale = Math.pow(2, zoom);
  const cWorldX = ((centerLng + 180) / 360) * 256 * scale;
  const cSinLat = Math.sin(centerLat * Math.PI / 180);
  const cWorldY = (0.5 - Math.log((1 + cSinLat) / (1 - cSinLat)) / (4 * Math.PI)) * 256 * scale;
  const pWorldX = ((pointLng + 180) / 360) * 256 * scale;
  const pSinLat = Math.sin(pointLat * Math.PI / 180);
  const pWorldY = (0.5 - Math.log((1 + pSinLat) / (1 - pSinLat)) / (4 * Math.PI)) * 256 * scale;
  return {
    x: Math.round(half + (pWorldX - cWorldX)),
    y: Math.round(half + (pWorldY - cWorldY)),
  };
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = ((yi > point.lat) !== (yj > point.lat))
      && (point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi + 0.0) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function geometryContainsPoint(geometry, lat, lng) {
  if (!geometry) return false;
  const rings = geometry.rings || geometry.coordinates;
  const geometryType = geometry.type || (geometry.rings ? 'Polygon' : null);
  if (!geometryType) return false;

  const point = { lat, lng };

  const polygonContainsPoint = rings => {
    if (!Array.isArray(rings) || !rings.length) return false;
    if (!pointInRing(point, rings[0])) return false;
    for (let i = 1; i < rings.length; i += 1) {
      if (pointInRing(point, rings[i])) return false;
    }
    return true;
  };

  if (geometryType === 'Polygon') {
    return polygonContainsPoint(rings);
  }

  if (geometryType === 'MultiPolygon') {
    return rings.some(polygonContainsPoint);
  }

  return false;
}

function pickParcelFeature(features, lat, lng) {
  if (!Array.isArray(features) || !features.length) return null;

  const containing = features.find(feature => geometryContainsPoint(feature.geometry, lat, lng));
  if (containing) return containing;

  return features[0];
}

function geometryToOuterRing(geometry) {
  if (!geometry) return [];
  if (Array.isArray(geometry.rings) && geometry.rings.length) {
    return geometry.rings[0] || [];
  }
  if (!geometry.type) return [];

  if (geometry.type === 'Polygon') {
    return geometry.coordinates?.[0] || [];
  }

  if (geometry.type === 'MultiPolygon') {
    let bestRing = [];
    let bestArea = -1;
    for (const polygon of geometry.coordinates || []) {
      const ring = polygon?.[0] || [];
      const area = ringArea(ring);
      if (area > bestArea) {
        bestArea = area;
        bestRing = ring;
      }
    }
    return bestRing;
  }

  return [];
}

function ringToLatLngPath(ring) {
  const trimmed = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;

  return trimmed.map(([lng, lat]) => ({ lat, lng }));
}

function ringToPixelPath(ring, centerLat, centerLng, zoom, imgSize) {
  return ringToLatLngPath(ring).map(pt => latLngToPixel(pt.lat, pt.lng, centerLat, centerLng, zoom, imgSize));
}

function latLngPathToPixelPath(path, centerLat, centerLng, zoom, imgSize) {
  return (Array.isArray(path) ? path : []).map(point => latLngToPixel(point.lat, point.lng, centerLat, centerLng, zoom, imgSize));
}

async function fetchRegridParcel(lat, lng) {
  if (!REGRID_KEY) {
    return { boundaryLatLng: null, boundaryPixels: null, feature: null };
  }

  const endpoints = [
    {
      url: (() => {
        const u = new URL('https://app.regrid.com/api/v1/search.json');
        u.searchParams.set('lat', String(lat));
        u.searchParams.set('lon', String(lng));
        u.searchParams.set('radius', '20');
        u.searchParams.set('token', REGRID_KEY);
        return u;
      })(),
      featuresKey: 'results',
    },
    {
      url: (() => {
        const u = new URL('https://app.regrid.com/api/v2/parcels/point');
        u.searchParams.set('lat', String(lat));
        u.searchParams.set('lon', String(lng));
        u.searchParams.set('radius', '20');
        u.searchParams.set('limit', '5');
        u.searchParams.set('return_geometry', 'true');
        u.searchParams.set('token', REGRID_KEY);
        return u;
      })(),
      featuresKey: 'features',
    },
  ];

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint.url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      continue;
    }

    const data = await response.json();
    const features = data[endpoint.featuresKey] || data.features || data.parcels?.features || [];
    const feature = pickParcelFeature(features, lat, lng);
    if (!feature?.geometry) continue;

    const outerRing = geometryToOuterRing(feature.geometry);
    if (outerRing.length < 3) continue;

    return {
      feature,
      boundaryLatLng: ringToLatLngPath(outerRing),
      boundaryPixels: ringToPixelPath(outerRing, lat, lng, STATIC_ZOOM, STATIC_SIZE),
    };
  }

  return { boundaryLatLng: null, boundaryPixels: null, feature: null };
}

async function fetchLosAngelesCountyParcel(lat, lng) {
  const url = new URL('https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query');
  url.searchParams.set('geometry', JSON.stringify({
    x: lng,
    y: lat,
    spatialReference: { wkid: 4326 },
  }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outFields', '*');
  url.searchParams.set('f', 'json');

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    return { boundaryLatLng: null, boundaryPixels: null, feature: null };
  }

  const data = await response.json();
  const features = data.features || [];
  const feature = pickParcelFeature(features, lat, lng);
  if (!feature?.geometry) {
    return { boundaryLatLng: null, boundaryPixels: null, feature: null };
  }

  const outerRing = geometryToOuterRing(feature.geometry);
  if (outerRing.length < 3) {
    return { boundaryLatLng: null, boundaryPixels: null, feature: null };
  }

  return {
    feature,
    boundaryLatLng: ringToLatLngPath(outerRing),
    boundaryPixels: ringToPixelPath(outerRing, lat, lng, STATIC_ZOOM, STATIC_SIZE),
  };
}

async function fetchParcelBoundary(lat, lng) {
  const regridParcel = await fetchRegridParcel(lat, lng);
  if (regridParcel.boundaryLatLng) {
    return { ...regridParcel, source: 'regrid' };
  }

  const countyParcel = await fetchLosAngelesCountyParcel(lat, lng);
  if (countyParcel.boundaryLatLng) {
    return { ...countyParcel, source: 'lacounty' };
  }

  return { boundaryLatLng: null, boundaryPixels: null, feature: null, source: null };
}

function formatPathPoints(points) {
  return (Array.isArray(points) ? points : [])
    .filter(point => point && typeof point.lat === 'number' && typeof point.lng === 'number')
    .map(point => point.lat + ',' + point.lng)
    .join('|');
}

function buildExportMapUrl({ lat, lng, zoom, parcelBoundary, lawnBoundary }) {
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', lat + ',' + lng);
  url.searchParams.set('zoom', String(zoom || STATIC_ZOOM));
  url.searchParams.set('size', STATIC_SIZE + 'x' + STATIC_SIZE);
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'satellite');
  url.searchParams.set('markers', 'color:red%7Csize:mid%7C' + lat + ',' + lng);
  url.searchParams.set('key', MAPS_KEY);

  const parcelPath = formatPathPoints(parcelBoundary);
  if (parcelPath) {
    url.searchParams.append('path', [
      'fillcolor:0xFFE60022',
      'color:0xFFE600FF',
      'weight:4',
      parcelPath,
    ].join('|'));
  }

  const lawnPath = formatPathPoints(lawnBoundary);
  if (lawnPath) {
    url.searchParams.append('path', [
      'fillcolor:0xFF3B3033',
      'color:0xFF3B30FF',
      'weight:3',
      lawnPath,
    ].join('|'));
  }

  return url.toString();
}

function normalizeParcelBoundary(boundary) {
  if (!Array.isArray(boundary)) return [];
  return boundary
    .map(point => {
      if (!point) return null;
      if (Array.isArray(point) && point.length >= 2) {
        return { lat: Number(point[1]), lng: Number(point[0]) };
      }
      if (typeof point.lat === 'number' && typeof point.lng === 'number') {
        return { lat: point.lat, lng: point.lng };
      }
      return null;
    })
    .filter(Boolean);
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 3) return sorted;

  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function simplifyPolygonPoints(points, maxPoints = 12) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);
  if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);
  return sampled;
}

function scorePolygonAgainstMask(polygon, mask, width, height) {
  if (!Array.isArray(polygon) || polygon.length < 3 || !mask || !width || !height) return 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    if (!point) continue;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return 0;

  const step = 4;
  let samples = 0;
  let greenHits = 0;
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(height - 1, Math.ceil(maxY)); y += step) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(width - 1, Math.ceil(maxX)); x += step) {
      if (!pointInPolygon({ x, y }, polygon)) continue;
      samples += 1;
      if (mask[y * width + x]) greenHits += 1;
    }
  }

  if (!samples) return 0;
  return greenHits / samples;
}

// ── Sutherland-Hodgman polygon clipping ─────────────────────────────────────
function _shEdgeSide(pt, a, b) {
  return (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
}
function _shIntersect(a, b, c, d) {
  const A1 = b.y - a.y, B1 = a.x - b.x, C1 = A1 * a.x + B1 * a.y;
  const A2 = d.y - c.y, B2 = c.x - d.x, C2 = A2 * c.x + B2 * c.y;
  const det = A1 * B2 - A2 * B1;
  if (Math.abs(det) < 1e-10) return { x: a.x, y: a.y };
  return { x: (B2 * C1 - B1 * C2) / det, y: (A1 * C2 - A2 * C1) / det };
}
function clipPolygonToParcel(polygon, parcel) {
  if (!parcel || parcel.length < 3) return polygon;
  let out = polygon.slice();
  const n = parcel.length;
  for (let i = 0; i < n; i++) {
    if (!out.length) return [];
    const inp = out; out = [];
    const a = parcel[i], b = parcel[(i + 1) % n];
    for (let j = 0; j < inp.length; j++) {
      const cur = inp[j], prev = inp[(j + inp.length - 1) % inp.length];
      const curIn  = _shEdgeSide(cur,  a, b) >= 0;
      const prevIn = _shEdgeSide(prev, a, b) >= 0;
      if (curIn)  { if (!prevIn) out.push(_shIntersect(prev, cur, a, b)); out.push(cur); }
      else if (prevIn) { out.push(_shIntersect(prev, cur, a, b)); }
    }
  }
  return out;
}

function polygonPixelArea(polygon) {
  const n = polygon.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b = polygon[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

// Convert RGB (0-255) to HSV. Returns [hue 0-360, saturation 0-1, value 0-1].
function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === gn)      h = 60 * (((bn - rn) / delta) + 2);
    else if (max === bn) h = 60 * (((rn - gn) / delta) + 4);
    else                 h = 60 * (((gn - bn) / delta) % 6);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : delta / max, max];
}

// Local 5×5 texture (stddev of grayscale): low = smooth lawn, high = rough tree canopy
function localStdDev5x5(data, x, y, width, height) {
  const vals = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const idx = (ny * width + nx) * 4;
      vals.push((data[idx] + data[idx + 1] + data[idx + 2]) / 3);
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
}

// Average brightness of pixels inside a polygon (sampled)
function computePolygonAvgBrightness(polygon, data, width, height) {
  if (!data || !polygon || polygon.length < 3) return 0;
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let total = 0, n = 0;
  const step = 4;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (!pointInPolygon({ x, y }, polygon)) continue;
      const idx = (y * width + x) * 4;
      total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      n++;
    }
  }
  return n ? total / n : 0;
}

// Average local texture (stddev) inside a polygon — high = tree canopy, low = smooth lawn
function computePolygonAvgTexture(polygon, data, width, height) {
  if (!data || !polygon || polygon.length < 3) return 10;
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let total = 0, n = 0;
  const step = 5;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (!pointInPolygon({ x, y }, polygon)) continue;
      total += localStdDev5x5(data, x, y, width, height);
      n++;
    }
  }
  return n ? total / n : 10;
}

function computePolygonColorStats(polygon, data, width, height) {
  if (!data || !polygon || polygon.length < 3) {
    return { avgHue: 0, avgSat: 0, avgGreenDominance: -255, greenRatio: 0, brownRatio: 0 };
  }

  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let sumHue = 0, sumHueSq = 0, sumSat = 0, sumSatSq = 0, sumGreenDominance = 0, samples = 0;
  let greenHits = 0, brownHits = 0;

  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      if (!pointInPolygon({ x, y }, polygon)) continue;
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const [hue, sat, val] = rgbToHsv(r, g, b);
      const greenDominance = g - Math.max(r, b);
      if (hue >= 65 && hue <= 150 && sat >= 0.20 && val >= 0.25 && greenDominance >= 8) greenHits++;
      if (hue >= 15 && hue <= 60 && sat >= 0.18 && val >= 0.18 && r >= g - 8 && r >= b - 4) brownHits++;
      sumHue += hue;
      sumHueSq += hue * hue;
      sumSat += sat;
      sumSatSq += sat * sat;
      sumGreenDominance += greenDominance;
      samples++;
    }
  }

  const avgHue = samples ? sumHue / samples : 0;
  const avgSat = samples ? sumSat / samples : 0;
  const hueStd = samples ? Math.sqrt(Math.max(0, (sumHueSq / samples) - (avgHue * avgHue))) : 0;
  const satStd = samples ? Math.sqrt(Math.max(0, (sumSatSq / samples) - (avgSat * avgSat))) : 0;
  return {
    avgHue,
    avgSat,
    hueStd,
    satStd,
    avgGreenDominance: samples ? sumGreenDominance / samples : -255,
    greenRatio: samples ? greenHits / samples : 0,
    brownRatio: samples ? brownHits / samples : 0,
  };
}

function isWarmSparseGreenPolygon(poly, data, width, height) {
  const colorStats = computePolygonColorStats(poly, data, width, height);
  return colorStats.avgHue >= 120
    && colorStats.avgSat <= 0.30
    && colorStats.avgGreenDominance <= 16
    && colorStats.greenRatio <= 0.65;
}

// Fraction of greenPoly's interior covered by any polygon in gptPolygons (0–1)
function computePolygonCoverage(greenPoly, gptPolygons) {
  if (!gptPolygons.length || !greenPoly.length) return 0;
  const xs = greenPoly.map(p => p.x), ys = greenPoly.map(p => p.y);
  const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
  let inside = 0, covered = 0;
  const step = 5;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (!pointInPolygon({ x, y }, greenPoly)) continue;
      inside++;
      if (gptPolygons.some(gpt => pointInPolygon({ x, y }, gpt))) covered++;
    }
  }
  return inside ? covered / inside : 0;
}

async function analyzeGreenLawn(staticUrl, parcelPixels) {
  if (!Array.isArray(parcelPixels) || parcelPixels.length < 3) return { polygon: [], mask: null, width: 0, height: 0 };

  const response = await fetch(staticUrl);
  if (!response.ok) return { polygon: [], mask: null, width: 0, height: 0 };

  const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  const { width, height, data } = png;
  const mask = new Uint8Array(width * height);
  const seeds = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!pointInPolygon({ x, y }, parcelPixels)) continue;
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const brightness = (r + g + b) / 3;
      const greenDominance = g - Math.max(r, b);
      const excessGreen = (2 * g) - r - b;

      // HSV-based grass detection — eliminates brown dirt (hue 15-40°) and grey roofs (sat < 20%)
      // Grass hue: 75-150°, Saturation > 20%, Value > 25%
      const [hue, sat, val] = rgbToHsv(r, g, b);
      const isGrassHue = hue >= 65 && hue <= 150;
      const isGrassGreen = isGrassHue && sat >= 0.20 && val >= 0.25;

      if (isGrassGreen) {
        mask[y * width + x] = 1;
        seeds.push({ x, y, g, brightness, greenDominance, excessGreen, hue, sat, val });
      }
    }
  }

  if (!seeds.length) return { polygon: [], mask, width, height };

  const visited = new Uint8Array(width * height);
  const components = [];
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],           [1,  0],
    [-1,  1], [0,  1],  [1,  1],
  ];

  for (const seed of seeds) {
    const seedIndex = seed.y * width + seed.x;
    if (visited[seedIndex]) continue;
    const queue = [seed];
    visited[seedIndex] = 1;
    const component = [];

    while (queue.length) {
      const current = queue.pop();
      component.push(current);
      for (const [dx, dy] of neighbors) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const index = ny * width + nx;
        if (visited[index] || !mask[index]) continue;
        visited[index] = 1;
        queue.push({ x: nx, y: ny });
      }
    }

    // 50 px ≈ ~8 sq ft at zoom 20 — catches thin grass strips while filtering noise
    if (component.length >= 50) components.push(component);
  }

  if (!components.length) return { polygons: [], polygon: [], mask, width, height };

  // Score every component and keep all significant ones (handles front yard + back yard etc.)
  const scoredComponents = components.map(component => {
    let sumGreen = 0;
    let sumBrightness = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of component) {
      const idx = (point.y * width + point.x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const brightness = (r + g + b) / 3;
      const greenDominance = g - Math.max(r, b);
      sumGreen += greenDominance;
      sumBrightness += brightness;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }

    const area = component.length;
    const avgGreen = sumGreen / area;
    const avgBrightness = sumBrightness / area;
    const widthPx = maxX - minX + 1;
    const heightPx = maxY - minY + 1;
    const compactness = area / (widthPx * heightPx);

    // Texture: sample ~30 pts per component to estimate avg local stddev
    // Smooth (< 12) = lawn, Rough (> 18) = tree canopy (TGDI paper, 2019)
    let sumTex = 0, texN = 0;
    const texStep = Math.max(1, Math.floor(component.length / 30));
    for (let pi = 0; pi < component.length; pi += texStep) {
      const pt = component[pi];
      sumTex += localStdDev5x5(data, pt.x, pt.y, width, height);
      texN++;
    }
    const avgTexture = texN ? sumTex / texN : 10;
    // textureFactor: smooth lawn=1.0, rough tree=0.1
    const textureFactor = avgTexture <= 12 ? 1.0
      : avgTexture >= 22 ? 0.10
      : 1.0 - (avgTexture - 12) / 11;

    // brightnessFactor: steeper ramp per research (brightness 80→1.0, 45→0.0)
    const brightnessFactor = Math.min(1.0, Math.max(0.05, (avgBrightness - 45) / 35));

    const score = area * (avgGreen + avgBrightness * 0.08) * (0.8 + compactness)
                  * brightnessFactor * textureFactor;

    const hull = convexHull(component.map(point => ({ x: point.x, y: point.y })));
    const polygon = hull.length >= 3
      ? simplifyPolygonPoints(hull, 12)
      : [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];

    return { polygon, score, area, avgBrightness, avgTexture, minX, minY, maxX, maxY };
  });

  scoredComponents.sort((a, b) => b.score - a.score);
  if (!scoredComponents.length) return { polygons: [], polygon: [], patches: [], mask, width, height };

  // Keep components >= 4% of top score (lowered from 8% to catch front yard + back yard).
  // Require brightness >= 45 to exclude near-black shadow patches.
  const topScore = scoredComponents[0].score;

  // Debug: log all components
  console.log('[green-seg] all components (' + scoredComponents.length + '):');
  scoredComponents.slice(0, 8).forEach((c, i) => {
    const pct = Math.round(c.score / topScore * 100);
    const sqft = Math.round(c.area * 0.1656);
    console.log('[comp-' + i + '] sqft=' + sqft + ' brightness=' + Math.round(c.avgBrightness) + ' texture=' + Math.round(c.avgTexture) + ' score%=' + pct + '%');
  });

  // Keep components >= 5% of top score, brightness >= 45, texture <= 22.
  // texture <= 22 leaves room for shaded or partially tree-covered grass while still excluding rough tree canopy.
  // Brightness > 185 components stay in significant for GPT hints exclusion but
  // are filtered from the fallback polygon list (see fallback path below).
  // Sort by AREA (largest first) after quality filtering — preserve all significant
  // lawn regions instead of truncating to the single largest fragment.
  const significant = scoredComponents
    .filter(c => c.score >= topScore * 0.05 && c.avgBrightness >= 45 && c.avgTexture <= 22)
    .sort((a, b) => b.area - a.area);

  const polygons = significant.map(c =>
    c.polygon.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) }))
  );

  // Bounding-box patches used as hints for GPT-4o prompt
  const patches = significant.map((c, i) => ({
    n: i + 1,
    x1: Math.round(c.minX), y1: Math.round(c.minY),
    x2: Math.round(c.maxX), y2: Math.round(c.maxY),
    brightness: Math.round(c.avgBrightness),
    texture:    Math.round(c.avgTexture),
  }));

  return {
    polygons,
    polygon: polygons[0] || [],    // backward compat: first (best) polygon
    patches,
    mask,
    data,      // raw RGBA for brightness validation of GPT polygons
    width,
    height,
    componentScore: topScore,
  };
}

async function findGreenLawnPolygon(staticUrl, parcelPixels) {
  const analysis = await analyzeGreenLawn(staticUrl, parcelPixels);
  return analysis.polygon || [];
}

function buildLawnPromptLines({ parcelPixels, strict = true, greenPatches = [] }) {
  const parcelContext = parcelPixels
    ? [
        '━━ CONFIRMED PROPERTY BOUNDARY (from parcel data) ━━',
        'The exact parcel boundary in pixel coordinates is:',
        JSON.stringify(parcelPixels),
        'ONLY look for grass INSIDE this polygon. Ignore everything outside it.',
        '',
      ]
    : [
        '━━ FIND THE TARGET PROPERTY ━━',
        'There is a RED MAP PIN marker visible in this image.',
        'The red pin marks the EXACT property address.',
        'The property is the residential lot where the red pin is placed.',
        'Use the red pin as your anchor — identify which lot/parcel it sits on.',
        '',
      ];

  const grassGuidance = strict
    ? [
        'Inside the target property ONLY, identify BRIGHT GREEN grass/turf — not brown, not tan, not grey.',
        'Grass is medium-bright GREEN. Brown dirt, tan soil, grey roofs, red tiles are NOT grass.',
        'Trace only the outer edge of the clearly GREEN lawn area.',
        'If the green pre-scan shows multiple regions, inspect all of them and return every lawn polygon, even small second lawns.',
        'If the parcel has front yard, back yard, or side strips, return each lawn area separately when visible.',
        'If you can see both a front lawn and a back lawn, return both even when one is smaller, shaded, or partially hidden.',
        'Do not merge separate lawn patches into one polygon.',
        'If the lawn is thin, L-shaped, or split by a walkway, keep the full visible grass shape instead of shrinking to the brightest patch.',
        'If the lawn is a thin green strip, trace the strip exactly.',
        'If there is NO clearly green grass patch visible, return empty array [].',
      ]
    : [
        'Retry: look for any patch that is clearly GREEN or visibly shaded grass (not brown/tan/grey) inside the parcel.',
        'A residential lawn may be a rectangle, strip, L-shape, front yard, back yard, or side yard.',
        'If the green pre-scan shows multiple regions, inspect all of them and return every lawn polygon, even small second lawns.',
        'Return every distinct lawn polygon you can see; do not stop after the first patch.',
        'If you can see both a front lawn and a back lawn, return both even when one is smaller, shaded, or partially hidden.',
        'Do not merge separate lawn patches into one polygon.',
        'If nothing is green, return [].',
      ];

  const patchHints = greenPatches.length > 0
    ? [
        '━━ GREEN PIXEL PRE-SCAN (from color analysis) ━━',
        'Color analysis detected ' + greenPatches.length + ' bright-green region(s) inside the parcel:',
        ...greenPatches.map(p =>
          '  Region ' + p.n + ': pixels x=' + p.x1 + '-' + p.x2 + ', y=' + p.y1 + '-' + p.y2
          + ' (avg brightness ' + p.brightness + '/255 — '
          + (p.brightness >= 72 ? 'LIKELY LAWN (bright, smooth)' : p.brightness >= 58 ? 'mixed/borderline' : 'LIKELY TREE/SHRUB (dark, rough)')
          + ')'
        ),
        'Trace LIKELY LAWN regions first. Keep smaller separate lawn regions too; do not omit a front yard or back yard just because another lawn is larger.',
        'Mixed/borderline regions: include them if they still look like mowable grass, even when partially shaded by trees or shadows.',
        '',
      ]
    : [];

  return [
    'Satellite image: ' + STATIC_SIZE + 'x' + STATIC_SIZE + ' px, zoom ' + STATIC_ZOOM + '.',
    '',
    ...parcelContext,
    ...patchHints,
    '━━ YOUR TASK: FIND ONLY VISIBLE GRASS/LAWN ━━',
    ...grassGuidance,
    'Exclude: roof, shingles, driveway, concrete, pavers, cars, trees, shrubs, dirt, mulch, road, shadows.',
    '',
    '━━ RETURN FORMAT ━━',
    'Return ONLY valid JSON, no markdown:',
    '{',
    '  "lawn_polygons": [[{"x":120,"y":220}, ...], [{"x":350,"y":400}, ...]],',
    '  "confidence": "high"',
    '}',
    '- lawn_polygons: array of SEPARATE grass areas (e.g. front yard AND back yard as two entries)',
    '- Each inner array: 6–16 clockwise points tracing one continuous grass patch',
    '- Single lawn area → single-element outer array. No grass at all → empty outer array []',
    '- All x,y integers 0–' + STATIC_SIZE,
    'ADDITIONAL GUIDANCE:\nReturn all distinct lawn polygons you can confidently see inside the parcel.\nIf the property has separate front and back lawns, return both as separate polygons.\nTrace tightly around each green area only. Do not use the full parcel boundary as any polygon.',
    'ADDITIONAL GUIDANCE:\nGrass = bright/medium GREEN color. Brown or tan areas are bare soil ? exclude them.\nDo NOT include roof, driveway, bare soil, trees, or shadows in any polygon, unless the shadow/tree cover still clearly reveals the mowable grass footprint.',
    'ADDITIONAL GUIDANCE:\nIMPORTANT: Even if the grass area is small, partially shaded, or looks brownish/dry, identify it.\nLook carefully for ANY patch that has grass texture ? even a 3x3 meter patch counts.\nIf there are multiple separate lawns, return all of them. Do not stop after the first visible patch.\nThe property at the red pin is a residential lot. It likely has at least some lawn.\nDo NOT return empty polygon ? if unsure, estimate the most likely grass area.',
        '- confidence: "high" / "medium" / "low"',
  ];
}

function simplifyPoints(points, maxPoints = 24) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const result = [];
  for (let i = 0; i < points.length; i += stride) {
    result.push(points[i]);
  }
  if (result[result.length - 1] !== points[points.length - 1]) {
    result.push(points[points.length - 1]);
  }
  return result;
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── API: /api/config ──────────────────────────────────────────────────────────
function handleConfig(res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ mapsKey: MAPS_KEY }));
}

// ── API: /api/parcel-boundary ────────────────────────────────────────────────
async function handleParcelBoundary(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { lat, lng } = JSON.parse(body);
      if (!lat || !lng) throw new Error('lat and lng required');

      const parcel = await fetchParcelBoundary(lat, lng);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        parcel_boundary: parcel.boundaryLatLng,
        source: parcel.source || 'parcel',
        parcel_match: parcel.feature ? {
          headline: parcel.feature.properties?.headline || '',
          path: parcel.feature.properties?.path || '',
        } : null,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ── API: /api/export-map ─────────────────────────────────────────────────────
async function handleExportMap(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}');
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      const zoom = Number(payload.zoom || STATIC_ZOOM);
      const parcelBoundary = Array.isArray(payload.parcel_boundary) ? payload.parcel_boundary : [];
      const lawnBoundary = Array.isArray(payload.lawn_boundary) ? payload.lawn_boundary : [];

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('lat and lng required');
      if (!MAPS_KEY) throw new Error('Google Maps API key missing');

      const mapUrl = buildExportMapUrl({ lat, lng, zoom, parcelBoundary, lawnBoundary });
      const response = await fetch(mapUrl, { headers: { Accept: 'image/png' } });
      if (!response.ok) {
        const text = await response.text();
        throw new Error('Static Maps request failed: ' + response.status + ' ' + text.slice(0, 200));
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="lawn-detection.png"',
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ── API: /api/detect-lawn ────────────────────────────────────────────────────
async function handleDetectLawn(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { lat, lng, parcel_boundary: providedBoundary, parcel_source: providedSource } = JSON.parse(body);
      if (!lat || !lng) throw new Error('lat and lng required');

      let parcel = null;
      let parcelBoundaryLatLng = normalizeParcelBoundary(providedBoundary);
      let parcelPixels = parcelBoundaryLatLng.length
        ? simplifyPoints(latLngPathToPixelPath(parcelBoundaryLatLng, lat, lng, STATIC_ZOOM, STATIC_SIZE))
        : [];
      let parcelSource = providedSource || null;

      if (!parcelBoundaryLatLng.length) {
        parcel = await fetchParcelBoundary(lat, lng);
        parcelBoundaryLatLng = parcel.boundaryLatLng || [];
        parcelPixels = simplifyPoints(parcel.boundaryPixels || []);
        parcelSource = parcel.source || parcelSource;
      }

      // ── STEP 2: GPT-4o finds GRASS inside the confirmed parcel ────────────
      // Add a red pin marker so GPT-4o knows exactly which property to analyse
      const staticUrl = 'https://maps.googleapis.com/maps/api/staticmap'
        + '?center=' + lat + ',' + lng
        + '&zoom=' + STATIC_ZOOM + '&size=' + STATIC_SIZE + 'x' + STATIC_SIZE
        + '&maptype=satellite'
        + '&markers=color:red%7Csize:mid%7C' + lat + ',' + lng
        + '&key=' + MAPS_KEY;

      // Run green segmentation FIRST — results are passed as spatial hints to GPT-4o
      const greenAnalysis = await analyzeGreenLawn(staticUrl, parcelPixels || []);
      const greenPatches = greenAnalysis.patches || [];
      // Only pass patches that are realistic lawn brightness (65-185) AND smooth (texture <= 20)
      // Excludes anomalously bright areas (>185) like artificial turf or ornamental gardens
      const brightPatches = greenPatches.filter(p => p.brightness >= 65 && p.brightness <= 185 && p.texture <= 20);
      dlog('green-seg', {
        lat, lng,
        totalPatches: greenPatches.length,
        lawnPatches: brightPatches.length,
        brightness: greenPatches.map(p => p.brightness),
        texture: greenPatches.map(p => p.texture),
      });

      let parsed = {};
      for (const promptLines of [
        buildLawnPromptLines({ parcelPixels, strict: true, greenPatches: brightPatches }),
        buildLawnPromptLines({ parcelPixels, strict: false, greenPatches: brightPatches }),
      ]) {
        const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + OPENAI_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: staticUrl, detail: 'high' } },
                { type: 'text', text: promptLines.join('\n') },
              ],
            }],
            max_tokens: 800,
          }),
        });

        if (!aiResponse.ok) {
          const text = await aiResponse.text();
          throw new Error('OpenAI request failed: ' + aiResponse.status + ' ' + text.slice(0, 200));
        }

        const aiData    = await aiResponse.json();
        const content   = aiData.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

        // Support both new lawn_polygons (array) and old lawn_polygon (single)
        const gptPolygons = Array.isArray(parsed.lawn_polygons) ? parsed.lawn_polygons
          : (parsed.lawn_polygon?.length >= 3 ? [parsed.lawn_polygon] : []);
        dlog('gpt-raw', {
          confidence: parsed.confidence,
          polygonCount: gptPolygons.length,
          polygonAreas: gptPolygons.map(p => Math.round(polygonPixelArea(p) * 0.1656)),
        });
        if (gptPolygons.some(p => Array.isArray(p) && p.length >= 3)) break;
      }

      // Normalize GPT result — support both lawn_polygons (new) and lawn_polygon (old)
      let lawnPolygons = Array.isArray(parsed.lawn_polygons)
        ? parsed.lawn_polygons.filter(p => Array.isArray(p) && p.length >= 3)
        : (parsed.lawn_polygon?.length >= 3 ? [parsed.lawn_polygon] : []);
      let sourceSuffix = 'gpt4o';

      const hasGreenMask = greenAnalysis?.mask && greenAnalysis.width && greenAnalysis.height;
      const MIN_OUTPUT_PX2 = 604; // ~100 sq ft at zoom 20
      const greenFallbackPolygons = (greenAnalysis.polygons || [])
        .filter(p => Array.isArray(p) && p.length >= 3)
        .filter(p => polygonPixelArea(p) >= MIN_OUTPUT_PX2)
        .filter(p => !greenAnalysis.data || !isWarmSparseGreenPolygon(p, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height));

      // ── Step 1: Clip every GPT polygon to the parcel boundary ──
      if (parcelPixels.length >= 3) {
        lawnPolygons = lawnPolygons
          .map(p => clipPolygonToParcel(p, parcelPixels))
          .filter(p => p.length >= 3);
        console.log('[clip] polygons after parcel clip: ' + lawnPolygons.length);
      }

      // ── Step 2: Per-polygon validation — must have green pixels AND smooth texture (not tree) ──
      // GREEN_MIN=0.55: polygon must be >55% HSV-green pixels. Roofs/dirt typically score 5-30%.
      const GREEN_MIN = 0.55;
      // LARGE_POLY_PX2: polygons bigger than ~2000 sq ft need even higher green coverage (>70%)
      // to avoid accepting a "yard + house roof" combo that GPT drew too large.
      const LARGE_POLY_PX2 = 12000; // ~2000 sq ft at zoom 20
      let rejectedWarmSparseGreen = false;

      if (hasGreenMask && lawnPolygons.length > 0 && greenAnalysis.data) {
        lawnPolygons = lawnPolygons.filter(poly => {
          const score   = scorePolygonAgainstMask(poly, greenAnalysis.mask, greenAnalysis.width, greenAnalysis.height);
          const area    = polygonPixelArea(poly);
          const sqft    = Math.round(area * 0.1656);
          const minGreen = area > LARGE_POLY_PX2 ? 0.70 : GREEN_MIN;
          const colorStats = computePolygonColorStats(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height);
          if (score < minGreen) {
            dlog('gpt-reject', { reason: 'low-green', greenScore: +score.toFixed(3), minRequired: minGreen, areaPx: Math.round(area), sqft });
            return false;
          }
          const texture = computePolygonAvgTexture(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height);
          if (texture > 22) {
            dlog('gpt-reject', { reason: 'tree-texture', texture: +texture.toFixed(1), greenScore: +score.toFixed(3), sqft });
            return false;
          }
          if (isWarmSparseGreenPolygon(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height)) {
            rejectedWarmSparseGreen = true;
            dlog('gpt-reject', {
              reason: 'warm-sparse-green',
              brownRatio: +colorStats.brownRatio.toFixed(2),
              avgHue: Math.round(colorStats.avgHue),
              avgSat: +colorStats.avgSat.toFixed(2),
              hueStd: +colorStats.hueStd.toFixed(1),
              satStd: +colorStats.satStd.toFixed(2),
              greenDominance: Math.round(colorStats.avgGreenDominance),
              greenScore: +score.toFixed(3),
              sqft,
            });
            return false;
          }
          dlog('gpt-accept', {
            greenScore: +score.toFixed(3),
            texture: +texture.toFixed(1),
            greenRatio: +colorStats.greenRatio.toFixed(2),
            brownRatio: +colorStats.brownRatio.toFixed(2),
            avgHue: Math.round(colorStats.avgHue),
            avgSat: +colorStats.avgSat.toFixed(2),
            hueStd: +colorStats.hueStd.toFixed(1),
            satStd: +colorStats.satStd.toFixed(2),
            greenDominance: Math.round(colorStats.avgGreenDominance),
            sqft,
          });
          return true;
        });
        dlog('gpt-filter', { polygonsRemaining: lawnPolygons.length });
      } else if (hasGreenMask && lawnPolygons.length > 0) {
        lawnPolygons = lawnPolygons.filter(poly => {
          const score = scorePolygonAgainstMask(poly, greenAnalysis.mask, greenAnalysis.width, greenAnalysis.height);
          const sqft  = Math.round(polygonPixelArea(poly) * 0.1656);
          if (score < GREEN_MIN) {
            dlog('gpt-reject', { reason: 'low-green-nomask', greenScore: +score.toFixed(3), sqft });
            return false;
          }
          return true;
        });
      }

      // At zoom 20 ~34° lat: 1 px² ≈ 0.1656 sq ft. Require >= 100 sq ft (~604 px²) per polygon.
      const GPT_MIN_PX2 = 604;
      lawnPolygons = lawnPolygons.filter(poly => polygonPixelArea(poly) >= GPT_MIN_PX2);
      const gptTotalArea = lawnPolygons.reduce((s, p) => s + polygonPixelArea(p), 0);
      if (lawnPolygons.length > 0 && gptTotalArea >= GPT_MIN_PX2) {
        sourceSuffix = 'gpt4o';

        // ── Post-GPT validation: drop polygons whose interior is too dark (tree canopy) ──
        if (greenAnalysis.data) {
          const before = lawnPolygons.length;
          lawnPolygons = lawnPolygons.filter(poly => {
            const b = computePolygonAvgBrightness(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height);
            if (b < 55) { console.log('[gpt-filter] dropped dark polygon brightness=' + Math.round(b)); return false; }
            return true;
          });
          if (lawnPolygons.length === 0 && greenFallbackPolygons.length > 0 && !rejectedWarmSparseGreen) {
            // All GPT polygons were trees or too small — fall back to the green segmentation result.
            lawnPolygons = greenFallbackPolygons;
            sourceSuffix = 'green-fallback';
          } else if (lawnPolygons.length < before) {
            console.log('[gpt-filter] removed ' + (before - lawnPolygons.length) + ' dark polygons');
          }
        }

      } else if (greenFallbackPolygons.length > 0 && !rejectedWarmSparseGreen) {
        // Green-seg fallback — keep every valid lawn region the segmentation found.
        lawnPolygons = greenFallbackPolygons;
        sourceSuffix = 'green-fallback';
        if (!parsed.confidence || parsed.confidence === 'low') {
          parsed.confidence = 'medium';
        }
      }

      // ── Final outcome log ──
      const finalSqft = lawnPolygons.reduce((s, p) => s + Math.round(polygonPixelArea(p) * 0.1656), 0);
      dlog('result', {
        lat, lng,
        source: parcelBoundaryLatLng.length ? `${parcelSource || 'parcel'}+${sourceSuffix}` : sourceSuffix,
        polygonCount: lawnPolygons.length,
        totalSqft: finalSqft,
        confidence: parsed.confidence || 'medium',
        parcelPts: parcelPixels.length,
      });

      // Return combined result — parcel from Regrid/County + lawn areas from GPT-4o or green fallback
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        parcel_boundary:   parcelBoundaryLatLng,
        debug_parcel_pixels: parcelPixels,            // pixel-space parcel boundary for visualisation
        lawn_polygons:     lawnPolygons,              // array of separate lawn areas
        lawn_polygon:      lawnPolygons[0] || [],     // backward compat
        confidence:        parsed.confidence   || 'medium',
        source:            parcelBoundaryLatLng.length ? `${parcelSource || 'parcel'}+${sourceSuffix}` : sourceSuffix,
        parcel_match:      parcel?.feature ? {
          headline: parcel.feature.properties?.headline || '',
          path: parcel.feature.properties?.path || '',
        } : null,
      }));

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ── Static file server ────────────────────────────────────────────────────────
const STATIC_ROOT = path.resolve(__dirname) + path.sep;

function serveStatic(req, res) {
  const decoded = decodeURIComponent(req.url.split('?')[0]);
  const safeRel = path.normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = path.resolve(__dirname, safeRel === '' ? 'index.html' : safeRel);

  // Reject any path that escapes the project directory
  if (!candidate.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.realpath(candidate, (err, real) => {
    if (err || !real.startsWith(STATIC_ROOT)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext  = path.extname(real);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(real).pipe(res);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  if (url === '/api/config' && req.method === 'GET') return handleConfig(res);
  if (url === '/api/parcel-boundary' && req.method === 'POST') return handleParcelBoundary(req, res);
  if (url === '/api/export-map' && req.method === 'POST') return handleExportMap(req, res);
  if (url === '/api/detect-lawn' && req.method === 'POST') return handleDetectLawn(req, res);

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('\n✅ UFS Lawn Mowing Ad running at http://localhost:' + PORT);
  console.log('   Maps key loaded :', MAPS_KEY ? '✓' : '✗ MISSING');
  console.log('   OpenAI key loaded:', OPENAI_KEY ? '✓' : '✗ MISSING');
  console.log('\n   Press Ctrl+C to stop\n');
});
