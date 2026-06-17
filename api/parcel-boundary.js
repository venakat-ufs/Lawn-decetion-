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
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
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
    const outerRing = geometryToOuterRing(feature?.geometry);
    if (outerRing.length >= 3) {
      return {
        parcel_boundary: ringToLatLngPath(outerRing),
        source: 'regrid',
        parcel_match: feature ? {
          headline: feature.properties?.headline || '',
          path: feature.properties?.path || '',
        } : null,
      };
    }
  }
  return { parcel_boundary: [], source: null, parcel_match: null };
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
  if (!response.ok) return { parcel_boundary: [], source: null, parcel_match: null };

  const data = await response.json();
  const features = data.features || [];
  const feature = pickParcelFeature(features, lat, lng);
  const outerRing = geometryToOuterRing(feature?.geometry);
  if (outerRing.length < 3) return { parcel_boundary: [], source: null, parcel_match: null };

  return {
    parcel_boundary: ringToLatLngPath(outerRing),
    source: 'lacounty',
    parcel_match: feature ? {
      headline: feature.attributes?.SitusFullAddress || feature.attributes?.SitusAddress || '',
      path: '',
    } : null,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lat, lng } = req.body || {};
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });

  const regridKey = process.env.REGRID_API_KEY;

  try {
    if (regridKey) {
      const regrid = await fetchRegridParcel(lat, lng, regridKey);
      if (regrid.parcel_boundary.length) return res.json(regrid);
    }
    const county = await fetchLosAngelesCountyParcel(lat, lng);
    return res.json(county);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Parcel lookup failed' });
  }
};
