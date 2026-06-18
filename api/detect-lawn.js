const { PNG } = require('pngjs');

const STATIC_SIZE = 640;
const STATIC_ZOOM = 20;

// ── Coordinate helpers ────────────────────────────────────────────────────────
function latLngToPixel(pointLat, pointLng, centerLat, centerLng, zoom, imgSize) {
  const half = imgSize / 2, scale = Math.pow(2, zoom);
  const cWorldX = ((centerLng + 180) / 360) * 256 * scale;
  const cSinLat = Math.sin(centerLat * Math.PI / 180);
  const cWorldY = (0.5 - Math.log((1 + cSinLat) / (1 - cSinLat)) / (4 * Math.PI)) * 256 * scale;
  const pWorldX = ((pointLng + 180) / 360) * 256 * scale;
  const pSinLat = Math.sin(pointLat * Math.PI / 180);
  const pWorldY = (0.5 - Math.log((1 + pSinLat) / (1 - pSinLat)) / (4 * Math.PI)) * 256 * scale;
  return { x: Math.round(half + (pWorldX - cWorldX)), y: Math.round(half + (pWorldY - cWorldY)) };
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum / 2);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
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
  const polygonContainsPoint = r => {
    if (!Array.isArray(r) || !r.length) return false;
    if (!pointInRing(point, r[0])) return false;
    for (let i = 1; i < r.length; i++) if (pointInRing(point, r[i])) return false;
    return true;
  };
  if (geometryType === 'Polygon') return polygonContainsPoint(rings);
  if (geometryType === 'MultiPolygon') return rings.some(polygonContainsPoint);
  return false;
}

function pickParcelFeature(features, lat, lng) {
  if (!Array.isArray(features) || !features.length) return null;
  return features.find(f => geometryContainsPoint(f.geometry, lat, lng)) || features[0];
}

function geometryToOuterRing(geometry) {
  if (!geometry) return [];
  if (Array.isArray(geometry.rings) && geometry.rings.length) return geometry.rings[0] || [];
  if (!geometry.type) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates?.[0] || [];
  if (geometry.type === 'MultiPolygon') {
    let bestRing = [], bestArea = -1;
    for (const polygon of geometry.coordinates || []) {
      const ring = polygon?.[0] || [];
      const area = ringArea(ring);
      if (area > bestArea) { bestArea = area; bestRing = ring; }
    }
    return bestRing;
  }
  return [];
}

function ringToLatLngPath(ring) {
  const trimmed = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1) : ring;
  return trimmed.map(([lng, lat]) => ({ lat, lng }));
}

function ringToPixelPath(ring, centerLat, centerLng, zoom, imgSize) {
  return ringToLatLngPath(ring).map(pt => latLngToPixel(pt.lat, pt.lng, centerLat, centerLng, zoom, imgSize));
}

function latLngPathToPixelPath(path, centerLat, centerLng, zoom, imgSize) {
  return (Array.isArray(path) ? path : []).map(pt => latLngToPixel(pt.lat, pt.lng, centerLat, centerLng, zoom, imgSize));
}

function normalizeParcelBoundary(boundary) {
  if (!Array.isArray(boundary)) return [];
  return boundary.map(point => {
    if (!point) return null;
    if (Array.isArray(point) && point.length >= 2) return { lat: Number(point[1]), lng: Number(point[0]) };
    if (typeof point.lat === 'number' && typeof point.lng === 'number') return { lat: point.lat, lng: point.lng };
    return null;
  }).filter(Boolean);
}

function simplifyPoints(points, maxPoints = 24) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const result = [];
  for (let i = 0; i < points.length; i += stride) result.push(points[i]);
  if (result[result.length - 1] !== points[points.length - 1]) result.push(points[points.length - 1]);
  return result;
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y, xj = polygon[j].x, yj = polygon[j].y;
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
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
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

function polygonPixelArea(polygon) {
  const n = polygon.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b = polygon[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

// ── Sutherland-Hodgman polygon clipping ───────────────────────────────────────
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
      const curIn = _shEdgeSide(cur, a, b) >= 0;
      const prevIn = _shEdgeSide(prev, a, b) >= 0;
      if (curIn) { if (!prevIn) out.push(_shIntersect(prev, cur, a, b)); out.push(cur); }
      else if (prevIn) out.push(_shIntersect(prev, cur, a, b));
    }
  }
  return out;
}

// ── Texture analysis ──────────────────────────────────────────────────────────
function localStdDev5x5(data, x, y, width, height) {
  const vals = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const idx = (ny * width + nx) * 4;
    vals.push((data[idx] + data[idx + 1] + data[idx + 2]) / 3);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
}

function scorePolygonAgainstMask(polygon, mask, width, height) {
  if (!Array.isArray(polygon) || polygon.length < 3 || !mask || !width || !height) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (!p) continue;
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return 0;
  const step = 4;
  let samples = 0, greenHits = 0;
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(height - 1, Math.ceil(maxY)); y += step) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(width - 1, Math.ceil(maxX)); x += step) {
      if (!pointInPolygon({ x, y }, polygon)) continue;
      samples++;
      if (mask[y * width + x]) greenHits++;
    }
  }
  return samples ? greenHits / samples : 0;
}

function computePolygonAvgBrightness(polygon, data, width, height) {
  if (!data || !polygon || polygon.length < 3) return 0;
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let total = 0, n = 0;
  for (let y = minY; y <= maxY; y += 4) for (let x = minX; x <= maxX; x += 4) {
    if (!pointInPolygon({ x, y }, polygon)) continue;
    const idx = (y * width + x) * 4;
    total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    n++;
  }
  return n ? total / n : 0;
}

function computePolygonAvgTexture(polygon, data, width, height) {
  if (!data || !polygon || polygon.length < 3) return 10;
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  let total = 0, n = 0;
  for (let y = minY; y <= maxY; y += 5) for (let x = minX; x <= maxX; x += 5) {
    if (!pointInPolygon({ x, y }, polygon)) continue;
    total += localStdDev5x5(data, x, y, width, height);
    n++;
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

function computePolygonCoverage(greenPoly, gptPolygons) {
  if (!gptPolygons.length || !greenPoly.length) return 0;
  const xs = greenPoly.map(p => p.x), ys = greenPoly.map(p => p.y);
  const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
  let inside = 0, covered = 0;
  for (let y = minY; y <= maxY; y += 5) for (let x = minX; x <= maxX; x += 5) {
    if (!pointInPolygon({ x, y }, greenPoly)) continue;
    inside++;
    if (gptPolygons.some(gpt => pointInPolygon({ x, y }, gpt))) covered++;
  }
  return inside ? covered / inside : 0;
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

// ── Green segmentation ────────────────────────────────────────────────────────
async function analyzeGreenLawn(staticUrl, parcelPixels) {
  if (!Array.isArray(parcelPixels) || parcelPixels.length < 3) return { polygon: [], mask: null, width: 0, height: 0 };

  const response = await fetch(staticUrl);
  if (!response.ok) return { polygon: [], mask: null, width: 0, height: 0 };

  const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  const { width, height, data } = png;
  const mask = new Uint8Array(width * height);
  const seeds = [];

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!pointInPolygon({ x, y }, parcelPixels)) continue;
    const idx = (y * width + x) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const brightness = (r + g + b) / 3;
    const greenDominance = g - Math.max(r, b);
    const excessGreen = (2 * g) - r - b;
    // HSV-based grass detection — eliminates brown dirt (hue 15-40°) and grey roofs (sat < 20%)
    const [hue, sat, val] = rgbToHsv(r, g, b);
    const isGrassGreen = hue >= 65 && hue <= 150 && sat >= 0.20 && val >= 0.25;
    if (isGrassGreen) { mask[y * width + x] = 1; seeds.push({ x, y, g, brightness, greenDominance, excessGreen, hue, sat, val }); }
  }

  if (!seeds.length) return { polygon: [], mask, width, height };

  const visited = new Uint8Array(width * height);
  const components = [];
  const neighbors = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

  for (const seed of seeds) {
    const seedIndex = seed.y * width + seed.x;
    if (visited[seedIndex]) continue;
    const queue = [seed]; visited[seedIndex] = 1; const component = [];
    while (queue.length) {
      const cur = queue.pop(); component.push(cur);
      for (const [dx, dy] of neighbors) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const index = ny * width + nx;
        if (visited[index] || !mask[index]) continue;
        visited[index] = 1; queue.push({ x: nx, y: ny });
      }
    }
    // 50 px ≈ ~8 sq ft at zoom 20 — catches thin grass strips while filtering noise
    if (component.length >= 50) components.push(component);
  }

  if (!components.length) return { polygons: [], polygon: [], mask, width, height };

  const scoredComponents = components.map(component => {
    let sumGreen = 0, sumBrightness = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of component) {
      const idx = (p.y * width + p.x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const brightness = (r + g + b) / 3;
      sumGreen += g - Math.max(r, b);
      sumBrightness += brightness;
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    const area = component.length;
    const avgGreen = sumGreen / area, avgBrightness = sumBrightness / area;
    const widthPx = maxX - minX + 1, heightPx = maxY - minY + 1;
    const compactness = area / (widthPx * heightPx);

    let sumTex = 0, texN = 0;
    const texStep = Math.max(1, Math.floor(component.length / 30));
    for (let pi = 0; pi < component.length; pi += texStep) {
      sumTex += localStdDev5x5(data, component[pi].x, component[pi].y, width, height);
      texN++;
    }
    const avgTexture = texN ? sumTex / texN : 10;
    const textureFactor = avgTexture <= 12 ? 1.0 : avgTexture >= 22 ? 0.10 : 1.0 - (avgTexture - 12) / 11;
    const brightnessFactor = Math.min(1.0, Math.max(0.05, (avgBrightness - 45) / 35));
    const score = area * (avgGreen + avgBrightness * 0.08) * (0.8 + compactness) * brightnessFactor * textureFactor;

    const hull = convexHull(component.map(p => ({ x: p.x, y: p.y })));
    const polygon = hull.length >= 3 ? simplifyPolygonPoints(hull, 12)
      : [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];

    return { polygon, score, area, avgBrightness, avgTexture, minX, minY, maxX, maxY };
  });

  scoredComponents.sort((a, b) => b.score - a.score);
  if (!scoredComponents.length) return { polygons: [], polygon: [], patches: [], mask, width, height };

  const topScore = scoredComponents[0].score;
  const significant = scoredComponents
    .filter(c => c.score >= topScore * 0.05 && c.avgBrightness >= 45 && c.avgTexture <= 18)
    .sort((a, b) => b.area - a.area);

  const polygons = significant.map(c => c.polygon.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })));
  const patches = significant.map((c, i) => ({
    n: i + 1,
    x1: Math.round(c.minX), y1: Math.round(c.minY),
    x2: Math.round(c.maxX), y2: Math.round(c.maxY),
    brightness: Math.round(c.avgBrightness),
    texture: Math.round(c.avgTexture),
  }));

  return { polygons, polygon: polygons[0] || [], patches, mask, data, width, height, componentScore: topScore };
}

// ── GPT prompt ────────────────────────────────────────────────────────────────
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
        'Use the red pin as your anchor — identify which lot/parcel it sits on.',
        '',
      ];

  const grassGuidance = strict
    ? [
        'Inside the target property ONLY, identify BRIGHT GREEN grass/turf — not brown, not tan, not grey.',
        'Grass is medium-bright GREEN. Brown dirt, tan soil, grey roofs, red tiles are NOT grass.',
        'Trace only the outer edge of the clearly GREEN lawn area.',
        'If the lawn is a thin green strip, trace the strip exactly.',
        'If there is NO clearly green grass patch visible, return empty array [].',
      ]
    : [
        'Retry mode: focus only on the brightest visible green patch inside the parcel.',
        'A residential lawn is a contiguous bright-green rectangle or strip.',
        'Return the tightest polygon around that one green patch.',
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
        'Trace regions marked LIKELY LAWN first. Ignore or skip LIKELY TREE/SHRUB regions.',
        'Mixed/borderline regions: include only if you can see clearly flat mowable grass texture.',
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
    'ADDITIONAL GUIDANCE:\nGrass = bright/medium GREEN color. Brown or tan areas are bare soil — exclude them.\nDo NOT include roof, driveway, bare soil, trees, or shadows in any polygon.',
    '- confidence: "high" / "medium" / "low"',
  ];
}

// ── Parcel fetching ───────────────────────────────────────────────────────────
async function fetchRegridParcel(lat, lng, regridKey) {
  const endpoints = [
    {
      url: (() => {
        const u = new URL('https://app.regrid.com/api/v1/search.json');
        u.searchParams.set('lat', String(lat)); u.searchParams.set('lon', String(lng));
        u.searchParams.set('radius', '20'); u.searchParams.set('token', regridKey);
        return u;
      })(),
      featuresKey: 'results',
    },
    {
      url: (() => {
        const u = new URL('https://app.regrid.com/api/v2/parcels/point');
        u.searchParams.set('lat', String(lat)); u.searchParams.set('lon', String(lng));
        u.searchParams.set('radius', '20'); u.searchParams.set('limit', '5');
        u.searchParams.set('return_geometry', 'true'); u.searchParams.set('token', regridKey);
        return u;
      })(),
      featuresKey: 'features',
    },
  ];

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint.url.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) continue;
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
  url.searchParams.set('geometry', JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('inSR', '4326'); url.searchParams.set('outSR', '4326');
  url.searchParams.set('returnGeometry', 'true'); url.searchParams.set('outFields', '*');
  url.searchParams.set('f', 'json');

  const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) return { boundaryLatLng: null, boundaryPixels: null, feature: null };

  const data = await response.json();
  const features = data.features || [];
  const feature = pickParcelFeature(features, lat, lng);
  if (!feature?.geometry) return { boundaryLatLng: null, boundaryPixels: null, feature: null };

  const outerRing = geometryToOuterRing(feature.geometry);
  if (outerRing.length < 3) return { boundaryLatLng: null, boundaryPixels: null, feature: null };

  return {
    feature,
    boundaryLatLng: ringToLatLngPath(outerRing),
    boundaryPixels: simplifyPoints(ringToPixelPath(outerRing, lat, lng, STATIC_ZOOM, STATIC_SIZE)),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lat, lng, parcel_boundary: providedBoundary, parcel_source: providedSource } = req.body || {};
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const regridKey = process.env.REGRID_API_KEY;

  if (!mapsKey || !openaiKey) return res.status(500).json({ error: 'Server misconfigured — missing API keys' });

  try {
    let parcelBoundaryLatLng = normalizeParcelBoundary(providedBoundary);
    let parcelPixels = parcelBoundaryLatLng.length
      ? simplifyPoints(latLngPathToPixelPath(parcelBoundaryLatLng, lat, lng, STATIC_ZOOM, STATIC_SIZE))
      : [];
    let parcelSource = providedSource || null;
    let parcel = null;

    if (!parcelBoundaryLatLng.length) {
      if (regridKey) {
        parcel = await fetchRegridParcel(lat, lng, regridKey);
        if (parcel.boundaryLatLng) {
          parcelBoundaryLatLng = parcel.boundaryLatLng;
          parcelPixels = simplifyPoints(parcel.boundaryPixels || []);
          parcelSource = 'regrid';
        }
      }
      if (!parcelBoundaryLatLng.length) {
        parcel = await fetchLosAngelesCountyParcel(lat, lng);
        parcelBoundaryLatLng = parcel.boundaryLatLng || [];
        parcelPixels = simplifyPoints(parcel.boundaryPixels || []);
        parcelSource = parcel.boundaryLatLng ? 'lacounty' : null;
      }
    }

    const staticUrl = 'https://maps.googleapis.com/maps/api/staticmap'
      + '?center=' + lat + ',' + lng
      + '&zoom=' + STATIC_ZOOM + '&size=' + STATIC_SIZE + 'x' + STATIC_SIZE
      + '&maptype=satellite'
      + '&markers=color:red%7Csize:mid%7C' + lat + ',' + lng
      + '&key=' + mapsKey;

    const greenAnalysis = await analyzeGreenLawn(staticUrl, parcelPixels || []);
    const greenPatches = greenAnalysis.patches || [];
    const brightPatches = greenPatches.filter(p => p.brightness >= 65 && p.brightness <= 185 && p.texture <= 20);

    let parsed = {};
    for (const promptLines of [
      buildLawnPromptLines({ parcelPixels, strict: true, greenPatches: brightPatches }),
      buildLawnPromptLines({ parcelPixels, strict: false, greenPatches: brightPatches }),
    ]) {
      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: staticUrl, detail: 'high' } },
            { type: 'text', text: promptLines.join('\n') },
          ]}],
          max_tokens: 800,
        }),
      });
      if (!aiRes.ok) { const t = await aiRes.text(); throw new Error('OpenAI failed: ' + aiRes.status + ' ' + t.slice(0, 200)); }
      const aiData = await aiRes.json();
      const content = aiData.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      const gptPolygons = Array.isArray(parsed.lawn_polygons) ? parsed.lawn_polygons
        : (parsed.lawn_polygon?.length >= 3 ? [parsed.lawn_polygon] : []);
      if (gptPolygons.some(p => Array.isArray(p) && p.length >= 3)) break;
    }

    let lawnPolygons = Array.isArray(parsed.lawn_polygons)
      ? parsed.lawn_polygons.filter(p => Array.isArray(p) && p.length >= 3)
      : (parsed.lawn_polygon?.length >= 3 ? [parsed.lawn_polygon] : []);
    let sourceSuffix = 'gpt4o';

    const hasGreenMask = greenAnalysis?.mask && greenAnalysis.width && greenAnalysis.height;
    const MIN_OUTPUT_PX2 = 604; // ~100 sq ft at zoom 20
    const greenFallbackPolygons = (greenAnalysis.polygons || [])
      .filter(p => Array.isArray(p) && p.length >= 3)
      .filter(p => polygonPixelArea(p) >= MIN_OUTPUT_PX2);
    const filteredGreenFallbackPolygons = greenAnalysis.data
      ? greenFallbackPolygons.filter(p => !isWarmSparseGreenPolygon(p, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height))
      : greenFallbackPolygons;

    // Step 1: Clip to parcel boundary
    if (parcelPixels.length >= 3) {
      lawnPolygons = lawnPolygons.map(p => clipPolygonToParcel(p, parcelPixels)).filter(p => p.length >= 3);
    }

    // Step 2: Per-polygon validation — GREEN_MIN=0.55, large polygons need 0.70
    const GREEN_MIN = 0.55;
    const LARGE_POLY_PX2 = 12000; // ~2000 sq ft
    let rejectedWarmSparseGreen = false;

    if (hasGreenMask && lawnPolygons.length > 0 && greenAnalysis.data) {
      lawnPolygons = lawnPolygons.filter(poly => {
        const score    = scorePolygonAgainstMask(poly, greenAnalysis.mask, greenAnalysis.width, greenAnalysis.height);
        const area     = polygonPixelArea(poly);
        const minGreen = area > LARGE_POLY_PX2 ? 0.70 : GREEN_MIN;
        const colorStats = computePolygonColorStats(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height);
        if (score < minGreen) { console.log('[gpt-reject] low-green score=' + score.toFixed(3) + ' min=' + minGreen + ' area=' + Math.round(area)); return false; }
        const texture = computePolygonAvgTexture(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height);
        if (texture > 18) { console.log('[gpt-reject] tree-texture=' + texture.toFixed(1)); return false; }
        if (isWarmSparseGreenPolygon(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height)) {
          rejectedWarmSparseGreen = true;
          console.log('[gpt-reject] warm-sparse-green hue=' + Math.round(colorStats.avgHue) + ' sat=' + colorStats.avgSat.toFixed(2) + ' hueStd=' + colorStats.hueStd.toFixed(1) + ' satStd=' + colorStats.satStd.toFixed(2) + ' greenDom=' + Math.round(colorStats.avgGreenDominance));
          return false;
        }
        console.log('[gpt-accept] score=' + score.toFixed(3) + ' texture=' + texture.toFixed(1) + ' greenRatio=' + colorStats.greenRatio.toFixed(2) + ' brownRatio=' + colorStats.brownRatio.toFixed(2) + ' hue=' + Math.round(colorStats.avgHue) + ' sat=' + colorStats.avgSat.toFixed(2) + ' hueStd=' + colorStats.hueStd.toFixed(1) + ' satStd=' + colorStats.satStd.toFixed(2) + ' greenDom=' + Math.round(colorStats.avgGreenDominance));
        return true;
      });
    } else if (hasGreenMask && lawnPolygons.length > 0) {
      lawnPolygons = lawnPolygons.filter(poly =>
        scorePolygonAgainstMask(poly, greenAnalysis.mask, greenAnalysis.width, greenAnalysis.height) >= GREEN_MIN
      );
    }

    const GPT_MIN_PX2 = MIN_OUTPUT_PX2;
    lawnPolygons = lawnPolygons.filter(poly => polygonPixelArea(poly) >= GPT_MIN_PX2);
    const gptTotalArea = lawnPolygons.reduce((s, p) => s + polygonPixelArea(p), 0);

    if (lawnPolygons.length > 0 && gptTotalArea >= GPT_MIN_PX2) {
      // Drop dark polygons (tree canopy); keep every valid polygon.
      if (greenAnalysis.data) {
        lawnPolygons = lawnPolygons.filter(poly => {
          const b = computePolygonAvgBrightness(poly, greenAnalysis.data, greenAnalysis.width, greenAnalysis.height);
          return b >= 60;
        });
        if (lawnPolygons.length === 0 && filteredGreenFallbackPolygons.length > 0 && !rejectedWarmSparseGreen) {
          lawnPolygons = filteredGreenFallbackPolygons;
          sourceSuffix = 'green-fallback';
        }
      }

    } else if (filteredGreenFallbackPolygons.length > 0 && !rejectedWarmSparseGreen) {
      lawnPolygons = filteredGreenFallbackPolygons;
      sourceSuffix = 'green-fallback';
      if (!parsed.confidence || parsed.confidence === 'low') parsed.confidence = 'medium';
    }

    return res.json({
      parcel_boundary: parcelBoundaryLatLng,
      lawn_polygons: lawnPolygons,
      lawn_polygon: lawnPolygons[0] || [],
      confidence: parsed.confidence || 'medium',
      source: parcelBoundaryLatLng.length ? (parcelSource || 'parcel') + '+' + sourceSuffix : sourceSuffix,
      parcel_match: parcel?.feature ? {
        headline: parcel.feature.properties?.headline || parcel.feature.attributes?.SitusFullAddress || '',
        path: parcel.feature.properties?.path || '',
      } : null,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Detection failed' });
  }
};
