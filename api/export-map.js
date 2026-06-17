function formatPathPoints(points) {
  return (Array.isArray(points) ? points : [])
    .filter(point => point && typeof point.lat === 'number' && typeof point.lng === 'number')
    .map(point => point.lat + ',' + point.lng)
    .join('|');
}

function buildExportMapUrl({ lat, lng, zoom, parcelBoundary, lawnBoundary, mapsKey }) {
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', lat + ',' + lng);
  url.searchParams.set('zoom', String(zoom || 20));
  url.searchParams.set('size', '640x640');
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'satellite');
  url.searchParams.set('markers', 'color:red%7Csize:mid%7C' + lat + ',' + lng);
  url.searchParams.set('key', mapsKey);

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!mapsKey) {
      return res.status(500).json({ error: 'Google Maps API key missing' });
    }

    const payload = req.body || {};
    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    const zoom = Number(payload.zoom || 20);
    const parcelBoundary = Array.isArray(payload.parcel_boundary) ? payload.parcel_boundary : [];
    const lawnBoundary = Array.isArray(payload.lawn_boundary) ? payload.lawn_boundary : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    const mapUrl = buildExportMapUrl({ lat, lng, zoom, parcelBoundary, lawnBoundary, mapsKey });
    const response = await fetch(mapUrl, { headers: { Accept: 'image/png' } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error('Static Maps request failed: ' + response.status + ' ' + text.slice(0, 200));
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="lawn-detection.png"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Export failed' });
  }
};
