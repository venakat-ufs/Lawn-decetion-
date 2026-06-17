import { PNG } from 'pngjs';

const STATIC_MAP_SIZE = 640;
const STATIC_ZOOM = 20;

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

  if (geometryType === 'Polygon') return polygonContainsPoint(rings);
  if (geometryType === 'MultiPolygon') return rings.some(polygonContainsPoint);
  return false;
}

function pickParcelFeature(features, lat, lng) {
  if (!Array.isArray(features) || !features.length) return null;
  return features.find(feature => geometryContainsPoint(feature.geometry, lat, lng)) || features[0];
}

function geometryToOuterRing(geometry) {
  if (!geometry) return [];
  if (Array.isArray(geometry.rings) && geometry.rings.length) return geometry.rings[0] || [];
  if (!geometry.type) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates?.[0] || [];
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
  const half = imgSize / 2;
  const scale = Math.pow(2, zoom);
  return ringToLatLngPath(ring).map(pt => {
    const cWorldX = ((centerLng + 180) / 360) * 256 * scale;
    const cSinLat = Math.sin(centerLat * Math.PI / 180);
    const cWorldY = (0.5 - Math.log((1 + cSinLat) / (1 - cSinLat)) / (4 * Math.PI)) * 256 * scale;
    const pWorldX = ((pt.lng + 180) / 360) * 256 * scale;
    const pSinLat = Math.sin(pt.lat * Math.PI / 180);
    const pWorldY = (0.5 - Math.log((1 + pSinLat) / (1 - pSinLat)) / (4 * Math.PI)) * 256 * scale;
    return {
      x: Math.round(half + (pWorldX - cWorldX)),
      y: Math.round(half + (pWorldY - cWorldY)),
    };
  });
}

function latLngPathToPixelPath(path, centerLat, centerLng, zoom, imgSize) {
  const ring = (Array.isArray(path) ? path : []).map(point => [point.lng, point.lat]);
  return ringToPixelPath(ring, centerLat, centerLng, zoom, imgSize);
}

function simplifyPoints(points, maxPoints = 24) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const result = [];
  for (let i = 0; i < points.length; i += stride) result.push(points[i]);
  if (result[result.length - 1] !== points[points.length - 1]) result.push(points[points.length - 1]);
  return result;
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

      const looksLikeGreen =
        (g >= 72 && greenDominance >= 8 && excessGreen >= 18 && brightness >= 42) ||
        (g >= 54 && greenDominance >= 5 && excessGreen >= 14 && brightness >= 35);

      if (looksLikeGreen) {
        mask[y * width + x] = 1;
        seeds.push({ x, y, g, brightness, greenDominance, excessGreen });
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

    if (component.length >= 25) components.push(component);
  }

  if (!components.length) return { polygon: [], mask, width, height };

  let best = null;
  let bestScore = -Infinity;
  for (const component of components) {
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
    const score = area * (avgGreen + avgBrightness * 0.08) * (0.8 + compactness);

    if (score > bestScore) {
      bestScore = score;
      best = { component, minX, minY, maxX, maxY, score };
    }
  }

  if (!best) return { polygon: [], mask, width, height };

  const hull = convexHull(best.component.map(point => ({ x: point.x, y: point.y })));
  const polygon = hull.length >= 3
    ? simplifyPolygonPoints(hull, 12)
    : [
        { x: best.minX, y: best.minY },
        { x: best.maxX, y: best.minY },
        { x: best.maxX, y: best.maxY },
        { x: best.minX, y: best.maxY },
      ];

  return {
    polygon: polygon.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })),
    mask,
    width,
    height,
    componentScore: best.score,
  };
}

async function findGreenLawnPolygon(staticUrl, parcelPixels) {
  const analysis = await analyzeGreenLawn(staticUrl, parcelPixels);
  return analysis.polygon || [];
}

function buildLawnPromptLines({ parcelPixels, strict = true }) {
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
        'Inside the target property ONLY, identify visible green turf / grass patches.',
        'Trace only the outer edge of the green lawn area.',
        'Look for the most obvious green or green-brown vegetation patch inside the parcel.',
        'If the lawn is a thin strip, trace the strip exactly.',
        'If there is any visible grass inside the parcel, return a tight polygon around that grass instead of empty.',
      ]
    : [
        'Retry mode: focus only on the brightest visible green patch inside the parcel.',
        'A residential lawn is usually a contiguous green rectangle or strip in a side yard or rear yard.',
        'If you can see any grass/turf at all, return the tightest polygon around that patch.',
        'Do not choose the roof or the full house footprint.',
      ];

  return [
    'Satellite image: ' + STATIC_MAP_SIZE + 'x' + STATIC_MAP_SIZE + ' pixels, zoom level ' + STATIC_ZOOM + '.',
    'Pixel (' + (STATIC_MAP_SIZE / 2) + ',' + (STATIC_MAP_SIZE / 2) + ') is the EXACT center and marks the target property.',
    '',
    ...parcelContext,
    '━━ YOUR TASK: FIND ONLY VISIBLE GRASS/LAWN ━━',
    ...grassGuidance,
    'Exclude: roof, shingles, driveway, concrete, pavers, cars, trees, shrubs, dirt, mulch, road, shadows.',
    '',
    'Return ONLY valid JSON, no markdown:',
    '{',
    '  "properties": [',
    '    {"id":1,"roof_color":"brown","boundary":[{"x":100,"y":150},...], "is_target":true}',
    '  ],',
    '  "target_id": 1,',
    '  "lawn_polygon": [{"x":120,"y":220},...],',
    '  "confidence": "high"',
    '}',
    '- boundary: 8–16 clockwise points traced along actual parcel edges',
    '- lawn_polygon: 8–16 clockwise points (inside target parcel only)',
    '- All x,y integers 0–' + STATIC_MAP_SIZE,
    '- No grass → lawn_polygon: []',
    'ADDITIONAL GUIDANCE:\nTrace only the grass, not the house footprint. If the lawn is a strip, follow the strip exactly.\nPrefer smaller, tighter polygons around visible turf.\nDo not use the parcel boundary as the lawn polygon.',
    'ADDITIONAL GUIDANCE:\nEven if the grass is small or dry, identify the visible grass patch only.\nLook for green or green-brown vegetation texture.\nDo NOT include roof, driveway, or bare soil.',
    '- confidence: "high" / "medium" / "low"',
  ];
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
  if (!feature?.geometry) return { boundaryLatLng: null, boundaryPixels: null, feature: null };

  const outerRing = geometryToOuterRing(feature.geometry);
  if (outerRing.length < 3) return { boundaryLatLng: null, boundaryPixels: null, feature: null };

  return {
    feature,
    boundaryLatLng: ringToLatLngPath(outerRing),
    boundaryPixels: simplifyPoints(ringToPixelPath(outerRing, lat, lng, STATIC_ZOOM, STATIC_MAP_SIZE)),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { lat, lng, parcel_boundary: providedBoundary, parcel_source: providedSource } = req.body || {};
  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const regridKey = process.env.REGRID_API_KEY;

  if (!mapsKey || !openaiKey) {
    return res.status(500).json({ error: 'Server misconfigured — missing API keys' });
  }

  let parcelBoundaryLatLng = normalizeParcelBoundary(providedBoundary);
  let parcelPixels = parcelBoundaryLatLng.length
    ? simplifyPoints(latLngPathToPixelPath(parcelBoundaryLatLng, lat, lng, STATIC_ZOOM, STATIC_MAP_SIZE))
    : null;
  let parcelFeature = null;
  let parcelSource = providedSource || null;

  if (!parcelBoundaryLatLng.length && regridKey) {
    const endpoints = [
      {
        url: (() => {
          const u = new URL('https://app.regrid.com/api/v1/search.json');
          u.searchParams.set('lat', String(lat));
          u.searchParams.set('lon', String(lng));
          u.searchParams.set('radius', '20');
          u.searchParams.set('token', regridKey);
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
          u.searchParams.set('token', regridKey);
          return u;
        })(),
        featuresKey: 'features',
      },
    ];

    for (const endpoint of endpoints) {
      const parcelRes = await fetch(endpoint.url.toString(), {
        headers: { Accept: 'application/json' },
      });

      if (!parcelRes.ok) continue;

      const parcelData = await parcelRes.json();
      const features = parcelData[endpoint.featuresKey] || parcelData.features || parcelData.parcels?.features || [];
      parcelFeature = pickParcelFeature(features, lat, lng);
      const outerRing = geometryToOuterRing(parcelFeature?.geometry);
      if (outerRing.length >= 3) {
        parcelBoundaryLatLng = ringToLatLngPath(outerRing);
        parcelPixels = simplifyPoints(ringToPixelPath(outerRing, lat, lng, STATIC_ZOOM, STATIC_MAP_SIZE));
        parcelSource = 'regrid';
        break;
      }
    }
  }

  if (!parcelBoundaryLatLng.length) {
    const countyParcel = await fetchLosAngelesCountyParcel(lat, lng);
    parcelBoundaryLatLng = countyParcel.boundaryLatLng;
    parcelPixels = countyParcel.boundaryPixels;
    parcelFeature = countyParcel.feature;
    parcelSource = parcelBoundaryLatLng ? 'lacounty' : null;
  }

  const staticUrl = 'https://maps.googleapis.com/maps/api/staticmap'
    + '?center=' + lat + ',' + lng
    + '&zoom=' + STATIC_ZOOM
    + '&size=' + STATIC_MAP_SIZE + 'x' + STATIC_MAP_SIZE
    + '&maptype=satellite&key=' + mapsKey;

  try {
    const greenAnalysis = await analyzeGreenLawn(staticUrl, parcelPixels || []);
    let parsed = {};
    for (const promptLines of [
      buildLawnPromptLines({ parcelPixels, strict: true }),
      buildLawnPromptLines({ parcelPixels, strict: false }),
    ]) {
      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + openaiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: staticUrl, detail: 'high' },
              },
              {
                type: 'text',
                text: promptLines.join('\n'),
              },
            ],
          }],
          max_tokens: 800,
        }),
      });

      if (!aiRes.ok) {
        const text = await aiRes.text();
        throw new Error('OpenAI request failed: ' + aiRes.status + ' ' + text.slice(0, 200));
      }

      const data = await aiRes.json();
      const content = data.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

        if ((parsed.lawn_polygon || []).length >= 3) {
          break;
        }
      }

      let lawnPolygon = parsed.lawn_polygon || [];
      let sourceSuffix = 'gpt4o';

      const hasGreenMask = greenAnalysis?.mask && greenAnalysis.width && greenAnalysis.height;
      const gptGreenScore = hasGreenMask
        ? scorePolygonAgainstMask(lawnPolygon, greenAnalysis.mask, greenAnalysis.width, greenAnalysis.height)
        : 0;
      const greenFallback = greenAnalysis.polygon || [];

      if (lawnPolygon.length >= 3 && hasGreenMask && gptGreenScore >= 0.18) {
        sourceSuffix = 'gpt4o';
      } else if (greenFallback.length >= 3) {
        lawnPolygon = greenFallback;
        sourceSuffix = 'green-fallback';
        if (!parsed.confidence || parsed.confidence === 'low') {
          parsed.confidence = 'medium';
        }
      } else if (lawnPolygon.length < 3) {
        lawnPolygon = [];
      }

    return res.json({
      parcel_boundary: parcelBoundaryLatLng,
      parcel_match: parcelFeature ? {
        headline: parcelFeature.properties?.headline || '',
        path: parcelFeature.properties?.path || '',
      } : null,
      lawn_polygon: lawnPolygon,
      confidence: parsed.confidence || 'medium',
      source: parcelBoundaryLatLng.length ? `${parcelSource || 'parcel'}+${sourceSuffix}` : sourceSuffix,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'OpenAI request failed' });
  }
}
