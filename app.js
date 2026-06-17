/* =========================================================================
   United Field Services — Lawn Mowing Ad
   All secrets loaded from env via /api/* endpoints — no keys in this file.
   ========================================================================= */

const STATIC_MAP_SIZE = 640;
const STATIC_ZOOM = 20;

const state = {
  address: '',
  latLng: null,
  sqft: 0,
  polygon: null,
  polygons: [],          // additional AI-detected lawn areas beyond the first
  propertyBoundary: null,
  parcelBoundary: null,
  parcelSource: null,
  marker: null,
  map: null,
  miniMap: null,
  miniPolygon: null,
  miniPolygons: [],      // additional polygons shown in the estimate mini-map
  drawingManager: null,
  frequency: 'weekly',
  boundaryRequestId: 0,
};
window.__state = state; // exposed for Playwright tests

// ── Pricing ───────────────────────────────────────────────────────────────────
function getBasePrice(sqft) {
  if (sqft <= 1000)  return { min: 35,  max: 50  };
  if (sqft <= 3000)  return { min: 50,  max: 80  };
  if (sqft <= 6000)  return { min: 80,  max: 120 };
  if (sqft <= 12000) return { min: 120, max: 160 };
  if (sqft <= 20000) return { min: 160, max: 220 };
  return { min: 220, max: null };
}

function getDiscountedPrice(base, freq) {
  const disc = { weekly: 0.10, biweekly: 0.05, 'one-time': 0, monthly: 0 };
  const d = disc[freq] || 0;
  const min = Math.round(base.min * (1 - d));
  const max = base.max ? Math.round(base.max * (1 - d)) : null;
  return max ? '$' + min + ' – $' + max : 'From $' + min;
}

function formatSqft(n) {
  return n.toLocaleString() + ' sq ft';
}

// ── Step navigation ───────────────────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('step-' + n);
  if (target) target.classList.add('active');
  window.scrollTo(0, 0);

  if (n === 2) {
    setTimeout(() => {
      if (state.map) {
        google.maps.event.trigger(state.map, 'resize');
        if (state.latLng) {
          state.map.setCenter(state.latLng);
          state.map.setZoom(21);
          addAddressMarker();
          loadParcelBoundary({ draw: true, fit: true });
        }
      }
    }, 150);
  }

  if (n === 3) renderEstimate();
  if (n === 4) renderBookingForm();
}
window.goToStep = goToStep;

// ── Step 1: address input ─────────────────────────────────────────────────────
function initStep1() {
  const input    = document.getElementById('addressInput');
  const startBtn = document.getElementById('startBtn');
  const hint     = document.getElementById('addrHint');

  const autocomplete = new google.maps.places.Autocomplete(input, {
    types: ['address'],
    componentRestrictions: { country: 'us' },
  });

  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace();
    if (!place.geometry) return;
    state.address = place.formatted_address || input.value;
    state.latLng  = place.geometry.location;
    state.parcelBoundary = null;
    state.parcelSource = null;
    hint.style.display = 'none';
  });

  input.addEventListener('change', () => {
    if (!state.latLng) {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address: input.value }, (results, status) => {
        if (status === 'OK' && results[0]) {
          state.address = results[0].formatted_address;
          state.latLng  = results[0].geometry.location;
          state.parcelBoundary = null;
          state.parcelSource = null;
          hint.style.display = 'none';
        }
      });
    }
  });

  startBtn.addEventListener('click', () => {
    if (!state.latLng) {
      hint.style.display = 'block';
      input.focus();
      return;
    }
    if (state.map) {
      state.map.setCenter(state.latLng);
      state.map.setZoom(21);
    }
    state.parcelBoundary = null;
    state.parcelSource = null;
    document.getElementById('mapAddressLabel').textContent = state.address;
    goToStep(2);
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') startBtn.click(); });
}

// ── Step 2: map + drawing ─────────────────────────────────────────────────────
function initMap() {
  state.map = new google.maps.Map(document.getElementById('map'), {
    zoom: 21,
    mapTypeId: 'satellite',
    tilt: 0,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    rotateControl: false,
  });

  state.drawingManager = new google.maps.drawing.DrawingManager({
    drawingMode: google.maps.drawing.OverlayType.POLYGON,
    drawingControl: false,
    polygonOptions: {
      fillColor: '#FF3B30',
      fillOpacity: 0.20,
      strokeColor: '#FF3B30',
      strokeWeight: 3,
      editable: false,
      draggable: false,
      zIndex: 1,
    },
  });
  state.drawingManager.setMap(state.map);

  google.maps.event.addListener(state.drawingManager, 'polygoncomplete', polygon => {
    if (state.polygon) state.polygon.setMap(null);
    // Clear any AI-detected multi-polygons — manual draw replaces them
    (state.polygons || []).forEach(p => p.setMap(null));
    state.polygons = [];
    state.polygon = polygon;
    updateSqft();

    const path = polygon.getPath();
    path.addListener('set_at', updateSqft);
    path.addListener('insert_at', updateSqft);
    path.addListener('remove_at', updateSqft);

    state.drawingManager.setDrawingMode(null);
    setActiveTool('editBtn');
    polygon.setEditable(true);
    document.getElementById('getEstimateBtn').disabled = false;
    document.getElementById('mapFooterHint').textContent = 'Drag the points to adjust your lawn outline';
  });

  initStep1();
  initToolbar();
  initMapFooter();
}
window.initMap = initMap;

function addAddressMarker() {
  if (state.marker) state.marker.setMap(null);
  state.marker = new google.maps.Marker({
    position: state.latLng,
    map: state.map,
    draggable: true,
    animation: google.maps.Animation.DROP,
    title: state.address,
  });
  state.marker.addListener('dragend', () => {
    state.latLng = state.marker.getPosition();
    state.map.panTo(state.latLng);
    loadParcelBoundary({ draw: true, fit: true });
  });
}

function updateSqft() {
  const allPolys = [
    ...(state.polygon ? [state.polygon] : []),
    ...(state.polygons || []),
  ];
  if (!allPolys.length) return;
  let totalArea = 0;
  for (const poly of allPolys) {
    if (poly?.getPath) totalArea += google.maps.geometry.spherical.computeArea(poly.getPath());
  }
  state.sqft = Math.round(totalArea * 10.7639);

  const display = document.getElementById('sqftDisplay');
  if (display) display.textContent = 'Lawn size: ' + formatSqft(state.sqft);

  let liveOverlay = document.getElementById('liveSqftOverlay');
  if (!liveOverlay) {
    liveOverlay = document.createElement('div');
    liveOverlay.id = 'liveSqftOverlay';
    liveOverlay.style.cssText = [
      'position:absolute', 'bottom:70px', 'left:50%', 'transform:translateX(-50%)',
      'background:rgba(31,31,31,0.92)', 'color:#fff',
      'padding:10px 20px', 'border-radius:999px',
      'font-family:DM Sans,sans-serif', 'font-size:15px', 'font-weight:700',
      'pointer-events:none', 'z-index:15', 'white-space:nowrap',
      'border:2px solid #FF3B30',
    ].join(';');
    document.getElementById('step-2').appendChild(liveOverlay);
  }
  liveOverlay.textContent = formatSqft(state.sqft);
  liveOverlay.style.display = 'block';
  document.getElementById('mapFooterHint').textContent = 'Lawn area: ' + formatSqft(state.sqft);
}

// ── AI Lawn Detection ─────────────────────────────────────────────────────────
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

// Clear all detection overlays
function clearDetectionOverlays(preserveBoundary = false) {
  if (state.polygon) { state.polygon.setMap(null); state.polygon = null; }
  (state.polygons || []).forEach(p => p.setMap(null));
  state.polygons = [];
  if (!preserveBoundary && state.propertyBoundary) {
    state.propertyBoundary.setMap(null);
    state.propertyBoundary = null;
  }
  (state.candidatePolygons || []).forEach(p => p.setMap(null));
  state.candidatePolygons = [];
  const sel = document.getElementById('propertySelectOverlay');
  if (sel) sel.remove();
}

function polygonToLatLngArray(polygon) {
  if (!polygon?.getPath) return [];
  return polygon.getPath().getArray().map(point => ({ lat: point.lat(), lng: point.lng() }));
}

async function saveDetectedMap() {
  if (!state.latLng) {
    alert('Pick an address first.');
    return;
  }

  const parcelBoundary = state.parcelBoundary || [];
  // Collect all lawn areas: primary polygon + additional polygons
  const allLawnBoundaries = [
    polygonToLatLngArray(state.polygon),
    ...(state.polygons || []).map(p => polygonToLatLngArray(p)),
  ].filter(arr => arr.length > 0);
  const lawnBoundary = allLawnBoundaries[0] || [];
  if (!parcelBoundary.length && !allLawnBoundaries.length) {
    alert('Nothing to save yet. Detect the lawn first.');
    return;
  }

  const response = await fetch('/api/export-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: state.latLng.lat(),
      lng: state.latLng.lng(),
      zoom: state.map?.getZoom?.() || STATIC_ZOOM,
      parcel_boundary: parcelBoundary,
      lawn_boundary: lawnBoundary,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to export image');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = (state.address || 'lawn-detection').replace(/[^\w.-]+/g, '_') + '.png';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadParcelBoundary({ draw = true, fit = true } = {}) {
  if (!state.latLng) return null;

  const requestId = ++state.boundaryRequestId;
  const lat = state.latLng.lat();
  const lng = state.latLng.lng();
  const footer = document.getElementById('mapFooterHint');

  if (footer) footer.textContent = 'Finding property boundary…';

  try {
    const boundaryRes = await fetch('/api/parcel-boundary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    });

    if (!boundaryRes.ok) {
      const e = await boundaryRes.json();
      throw new Error(e.error || 'Boundary lookup failed');
    }

    const boundaryResult = await boundaryRes.json();
    if (requestId !== state.boundaryRequestId) return boundaryResult;

    state.parcelBoundary = boundaryResult.parcel_boundary || [];
    state.parcelSource = boundaryResult.source || null;

    if (draw && state.parcelBoundary.length >= 3) {
      drawPropertyBoundary(state.parcelBoundary, state.parcelSource);
      if (fit) {
        const bounds = new google.maps.LatLngBounds();
        state.parcelBoundary.forEach(point => bounds.extend(point));
        state.map.fitBounds(bounds);
      }
    } else if (footer) {
      footer.textContent = 'No parcel boundary found — trace manually if needed';
    }

    return boundaryResult;
  } catch (err) {
    if (footer) footer.textContent = 'Boundary lookup failed — trace manually if needed';
    return null;
  }
}

// Remove a single lawn polygon and update everything
function removePolygon(poly) {
  poly.setMap(null);
  if (state.polygon === poly) {
    // Promote the first extra polygon to state.polygon so backward-compat holds
    state.polygon = state.polygons.length ? state.polygons.shift() : null;
  } else {
    state.polygons = state.polygons.filter(p => p !== poly);
  }
  const allPolys = [state.polygon, ...state.polygons].filter(Boolean);
  if (!allPolys.length) {
    state.sqft = 0;
    document.getElementById('getEstimateBtn').disabled = true;
    const liveOverlay = document.getElementById('liveSqftOverlay');
    if (liveOverlay) liveOverlay.style.display = 'none';
    document.getElementById('sqftDisplay').textContent = 'Draw your lawn to calculate size';
    document.getElementById('mapFooterHint').textContent = 'All areas removed — trace manually or re-detect';
  } else {
    updateSqft();
  }
}

// Show a small delete popup near the click point on a polygon
function showPolygonDeletePopup(poly, latLng) {
  const existing = document.getElementById('polygonDeletePopup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'polygonDeletePopup';
  popup.style.cssText = [
    'position:absolute', 'z-index:30',
    'background:rgba(31,31,31,0.96)', 'color:#fff',
    'padding:10px 14px', 'border-radius:8px',
    'font-family:DM Sans,sans-serif', 'font-size:13px',
    'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
    'display:flex', 'gap:8px', 'align-items:center',
    'pointer-events:all',
    'border:1px solid rgba(255,255,255,0.15)',
  ].join(';');

  const areaM2 = google.maps.geometry.spherical.computeArea(poly.getPath());
  const areaSqft = Math.round(areaM2 * 10.7639);

  const label = document.createElement('span');
  label.textContent = areaSqft.toLocaleString() + ' sq ft';
  label.style.cssText = 'color:#aaa;font-size:12px;';

  const delBtn = document.createElement('button');
  delBtn.textContent = '✕ Delete this area';
  delBtn.style.cssText = [
    'background:#FF3B30', 'color:#fff', 'border:none',
    'padding:5px 10px', 'border-radius:5px',
    'font-size:12px', 'font-weight:600', 'cursor:pointer',
  ].join(';');
  delBtn.onclick = () => { popup.remove(); removePolygon(poly); };

  popup.appendChild(label);
  popup.appendChild(delBtn);

  // Position the popup at the click point using the Maps overlay projection
  const overlayView = new google.maps.OverlayView();
  overlayView.onAdd = function () {
    const panes = this.getPanes();
    panes.floatPane.appendChild(popup);
  };
  overlayView.draw = function () {
    const proj = this.getProjection();
    const pt = proj.fromLatLngToDivPixel(latLng);
    popup.style.left = (pt.x - 60) + 'px';
    popup.style.top  = (pt.y - 60) + 'px';
  };
  overlayView.setMap(state.map);
  state._deletePopupOverlay = overlayView;

  // Close on map click elsewhere
  const closeListener = state.map.addListener('click', () => {
    popup.remove();
    google.maps.event.removeListener(closeListener);
  });
}

// Draw one or more confirmed lawn polygons (editable red)
function drawLawnPolygons(polygonsData, lat, lng, confidence, source) {
  const validPolygons = (polygonsData || []).filter(pts => pts && pts.length >= 3);
  if (!validPolygons.length) {
    document.getElementById('mapFooterHint').textContent =
      'No grass found — use Trace to draw manually';
    return;
  }

  validPolygons.forEach((lawnPoints, i) => {
    const path = lawnPoints.map(pt => pixelToLatLng(pt.x, pt.y, lat, lng, STATIC_ZOOM, STATIC_MAP_SIZE));
    const poly = new google.maps.Polygon({
      paths: path,
      fillColor: '#FF3B30', fillOpacity: 0.22,
      strokeColor: '#FF3B30', strokeWeight: 3,
      editable: true, draggable: false,
      map: state.map, zIndex: 2,
    });
    const pathObj = poly.getPath();
    pathObj.addListener('set_at', updateSqft);
    pathObj.addListener('insert_at', updateSqft);
    pathObj.addListener('remove_at', updateSqft);

    // Click polygon → show delete popup
    poly.addListener('click', (e) => {
      const existing = document.getElementById('polygonDeletePopup');
      if (existing) { existing.remove(); return; }
      showPolygonDeletePopup(poly, e.latLng);
    });

    if (i === 0) {
      state.polygon = poly;       // first polygon in state.polygon (backward compat)
    } else {
      state.polygons.push(poly);  // additional lawns in state.polygons
    }
  });

  if (state.drawingManager) state.drawingManager.setDrawingMode(null);
  setActiveTool('editBtn');
  document.getElementById('getEstimateBtn').disabled = false;
  updateSqft();

  const totalAreas = validPolygons.length;
  const srcLabel = source?.includes('green-fallback') ? 'Green segmentation' : 'AI detected';
  const areaLabel = totalAreas > 1 ? totalAreas + ' lawn areas' : 'lawn';
  document.getElementById('mapFooterHint').textContent =
    srcLabel + ': ' + areaLabel + ' (' + (confidence || '?') + ' confidence) — drag points to adjust';
}

// Show multiple properties for user to pick
function showPropertySelection(properties, lawnByTarget, lat, lng, confidence) {
  const COLORS = ['#4FC3F7', '#81C784', '#FFD54F', '#FF8A65'];

  // Draw all candidate property boundaries
  state.candidatePolygons = properties.map((prop, i) => {
    const path = prop.boundary.map(pt => pixelToLatLng(pt.x, pt.y, lat, lng, STATIC_ZOOM, STATIC_MAP_SIZE));
    const poly = new google.maps.Polygon({
      paths: path,
      fillColor: COLORS[i % COLORS.length],
      fillOpacity: prop.is_target ? 0.18 : 0.08,
      strokeColor: COLORS[i % COLORS.length],
      strokeWeight: prop.is_target ? 2.5 : 1.5,
      strokeOpacity: 0.9,
      editable: false, draggable: false,
      map: state.map, zIndex: 1,
    });
    return poly;
  });

  // Build selection overlay
  const overlay = document.createElement('div');
  overlay.id = 'propertySelectOverlay';
  overlay.style.cssText = [
    'position:absolute', 'top:72px', 'left:50%', 'transform:translateX(-50%)',
    'background:rgba(31,31,31,0.95)', 'color:#fff',
    'padding:16px 20px', 'border-radius:6px',
    'font-family:DM Sans,sans-serif', 'font-size:13px',
    'z-index:20', 'display:flex', 'flex-direction:column', 'gap:10px',
    'min-width:260px', 'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
  ].join(';');

  const title = document.createElement('p');
  title.style.cssText = 'margin:0;font-weight:700;font-size:14px;';
  title.textContent = 'Multiple properties detected. Which is yours?';
  overlay.appendChild(title);

  properties.forEach((prop, i) => {
    const btn = document.createElement('button');
    btn.style.cssText = [
      'display:flex', 'align-items:center', 'gap:10px',
      'background:rgba(255,255,255,0.08)', 'border:1.5px solid ' + COLORS[i % COLORS.length],
      'color:#fff', 'padding:10px 14px', 'border-radius:4px',
      'font-family:DM Sans,sans-serif', 'font-size:13px', 'font-weight:600',
      'cursor:pointer', 'text-align:left',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + COLORS[i % COLORS.length] + ';flex-shrink:0;';
    btn.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = 'Property ' + (i + 1)
      + (prop.roof_color ? ' · ' + prop.roof_color + ' roof' : '')
      + (prop.is_target ? ' (AI suggestion)' : '');
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      overlay.remove();
      // Clear candidate outlines
      (state.candidatePolygons || []).forEach(p => p.setMap(null));
      state.candidatePolygons = [];

      // Draw selected property boundary as white outline
      const bPath = prop.boundary.map(pt => pixelToLatLng(pt.x, pt.y, lat, lng, STATIC_ZOOM, STATIC_MAP_SIZE));
      state.propertyBoundary = new google.maps.Polygon({
        paths: bPath,
        fillColor: '#FFFFFF', fillOpacity: 0.05,
        strokeColor: '#FFFFFF', strokeWeight: 1.5, strokeOpacity: 0.6,
        editable: false, draggable: false,
        map: state.map, zIndex: 0,
      });

      // Use the lawn from the selected property if available, else the main one
      const lawn = (prop.is_target && lawnByTarget) ? lawnByTarget : null;
      if (lawn && lawn.length >= 3) {
        drawLawnPolygons([lawn], lat, lng, confidence, 'gpt4o');
      } else {
        document.getElementById('mapFooterHint').textContent =
          'No grass detected for this property — use Trace to draw manually';
      }
    });

    overlay.appendChild(btn);
  });

  document.getElementById('step-2').appendChild(overlay);
}

function drawPropertyBoundary(parcelBoundary, source) {
  if (!Array.isArray(parcelBoundary) || parcelBoundary.length < 3) return;

  if (state.propertyBoundary) state.propertyBoundary.setMap(null);
  state.propertyBoundary = new google.maps.Polygon({
    paths: parcelBoundary,
    fillColor: '#FFE600',
    fillOpacity: 0.04,
    strokeColor: '#FFE600',
    strokeWeight: 4,
    strokeOpacity: 1,
    editable: false,
    draggable: false,
    map: state.map,
    zIndex: 1,
  });

  const bounds = new google.maps.LatLngBounds();
  parcelBoundary.forEach(point => bounds.extend(point));
  state.map.fitBounds(bounds);

  const label = source === 'regrid'
    ? 'Regrid parcel boundary loaded'
    : source === 'lacounty'
      ? 'County parcel boundary loaded'
      : 'Property boundary loaded';

  document.getElementById('mapFooterHint').textContent = label + ' — detecting grass…';
}

async function detectLawn() {
  if (!state.latLng) return;

  const btn         = document.getElementById('autoDetectBtn');
  const aiOverlay   = document.getElementById('aiLoadingOverlay');
  const loadingText = document.getElementById('aiLoadingText');

  btn.classList.add('loading');
  btn.textContent = 'Detecting…';
  aiOverlay.style.display = 'flex';
  clearDetectionOverlays(true);

  try {
    const lat = state.latLng.lat();
    const lng = state.latLng.lng();
    const parcelBoundary = state.parcelBoundary || [];
    const parcelSource = state.parcelSource || 'parcel';

    if (!parcelBoundary.length) {
      loadingText.textContent = 'Step 1/2: Finding property boundary…';
      const boundaryResult = await loadParcelBoundary({ draw: true, fit: false });
      if (!boundaryResult?.parcel_boundary?.length) {
        document.getElementById('mapFooterHint').textContent =
          'No parcel boundary found — detecting lawn with AI only…';
      }
    }

    loadingText.textContent = 'Step 2/2: Detecting lawn inside boundary…';

    const res = await fetch('/api/detect-lawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat,
        lng,
        parcel_boundary: state.parcelBoundary || parcelBoundary,
        parcel_source: parcelSource,
      }),
    });

    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Server error'); }

    const result = await res.json();

    loadingText.textContent = 'Drawing results…';

    const lawnPolygons = result.lawn_polygons?.length
      ? result.lawn_polygons
      : (result.lawn_polygon?.length >= 3 ? [result.lawn_polygon] : []);
    const confidence   = result.confidence || 'medium';
    const source       = result.source     || 'gpt4o-only';

    // Draw all detected lawn areas (pixel coords → lat/lng)
    drawLawnPolygons(lawnPolygons, lat, lng, confidence, source);

  } catch (err) {
    alert('Auto-detect: ' + (err.message || 'Something went wrong. Please trace manually.'));
    setActiveTool('traceBtn');
    if (state.drawingManager) state.drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  } finally {
    aiOverlay.style.display = 'none';
    btn.classList.remove('loading');
    btn.textContent = 'Auto-Detect Lawn';
  }
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function setActiveTool(id) {
  document.querySelectorAll('.map-tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(id);
  if (btn) btn.classList.add('active');
}

function initToolbar() {
  document.getElementById('autoDetectBtn').addEventListener('click', detectLawn);
  document.getElementById('savePicBtn').addEventListener('click', async () => {
    try {
      await saveDetectedMap();
    } catch (err) {
      alert(err.message || 'Unable to save picture');
    }
  });

  document.getElementById('traceBtn').addEventListener('click', () => {
    if (state.polygon) { state.polygon.setMap(null); state.polygon = null; }
    (state.polygons || []).forEach(p => p.setMap(null));
    state.polygons = [];
    state.drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    setActiveTool('traceBtn');
    document.getElementById('getEstimateBtn').disabled = true;
    document.getElementById('sqftDisplay').textContent = 'Draw your lawn to calculate size';
    document.getElementById('mapFooterHint').textContent = 'Click around your lawn outline. Double-click to finish.';
  });

  document.getElementById('editBtn').addEventListener('click', () => {
    state.drawingManager.setDrawingMode(null);
    if (state.polygon) state.polygon.setEditable(true);
    (state.polygons || []).forEach(p => p.setEditable(true));
    setActiveTool('editBtn');
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (!state.polygon) return;
    const path = state.polygon.getPath();
    if (path.getLength() > 0) { path.removeAt(path.getLength() - 1); updateSqft(); }
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    state.boundaryRequestId += 1;
    clearDetectionOverlays();
    state.drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    setActiveTool('traceBtn');
    state.sqft = 0;
    state.parcelBoundary = null;
    state.parcelSource = null;
    document.getElementById('getEstimateBtn').disabled = true;
    document.getElementById('sqftDisplay').textContent = 'Draw your lawn to calculate size';
    document.getElementById('mapFooterHint').textContent = 'Trace your lawn area on the map above';
    const liveOverlay = document.getElementById('liveSqftOverlay');
    if (liveOverlay) liveOverlay.style.display = 'none';
  });

  document.getElementById('dismissHint').addEventListener('click', () => {
    document.getElementById('mapInstruction').style.display = 'none';
  });
}

function initMapFooter() {
  document.getElementById('backToStep1').addEventListener('click', () => goToStep(1));
  document.getElementById('getEstimateBtn').addEventListener('click', () => goToStep(3));
}

// ── Step 3: estimate ──────────────────────────────────────────────────────────
function renderEstimate() {
  const base     = getBasePrice(state.sqft);
  const freq     = document.querySelector('input[name="freq"]:checked')?.value || 'weekly';
  const priceStr = getDiscountedPrice(base, freq);

  document.getElementById('estimatePrice').textContent    = priceStr;
  document.getElementById('estimateSqft').textContent     = formatSqft(state.sqft);
  document.getElementById('estimateSqftStat').textContent = state.sqft.toLocaleString();
  document.getElementById('estimateAddress').textContent  = state.address;

  document.querySelectorAll('input[name="freq"]').forEach(radio => {
    radio.onchange = () => {
      const f = document.querySelector('input[name="freq"]:checked').value;
      document.getElementById('estimatePrice').textContent = getDiscountedPrice(base, f);
    };
  });

  if (!state.miniMap) {
    state.miniMap = new google.maps.Map(document.getElementById('miniMap'), {
      zoom: 20, mapTypeId: 'satellite', tilt: 0,
      disableDefaultUI: true, gestureHandling: 'none',
    });
  }
  if (state.latLng) { state.miniMap.setCenter(state.latLng); state.miniMap.setZoom(20); }

  if (state.miniPolygon) state.miniPolygon.setMap(null);
  (state.miniPolygons || []).forEach(p => p.setMap(null));
  state.miniPolygons = [];

  const allPolys = [
    ...(state.polygon ? [state.polygon] : []),
    ...(state.polygons || []),
  ];
  allPolys.forEach((poly, i) => {
    const miniPoly = new google.maps.Polygon({
      paths: poly.getPath().getArray(),
      fillColor: '#FF3B30', fillOpacity: 0.25,
      strokeColor: '#FF3B30', strokeWeight: 2,
      map: state.miniMap,
    });
    if (i === 0) state.miniPolygon = miniPoly;
    else state.miniPolygons.push(miniPoly);
  });

  setTimeout(() => google.maps.event.trigger(state.miniMap, 'resize'), 100);
  document.getElementById('bookNowBtn').onclick = () => goToStep(4);
}

// ── Step 4: booking form ──────────────────────────────────────────────────────
function renderBookingForm() {
  const freq     = document.querySelector('input[name="freq"]:checked')?.value || 'weekly';
  const base     = getBasePrice(state.sqft);
  const priceStr = getDiscountedPrice(base, freq);
  const labels   = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', 'one-time': 'One-time visit' };

  document.getElementById('summaryAddress').textContent = state.address || '—';
  document.getElementById('summarySqft').textContent    = formatSqft(state.sqft);
  document.getElementById('summaryFreq').textContent    = labels[freq] || freq;
  document.getElementById('summaryPrice').textContent   = priceStr;
  document.getElementById('bk-address').value           = state.address || '';

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  document.getElementById('bk-date').min = tomorrow.toISOString().split('T')[0];

  document.getElementById('bookingForm').onsubmit = e => {
    e.preventDefault();
    submitBooking(priceStr);
  };
}

function submitBooking(priceStr) {
  const date      = document.getElementById('bk-date').value;
  const formatted = date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : '—';
  document.getElementById('confirmAddress').textContent = state.address;
  document.getElementById('confirmPrice').textContent   = priceStr;
  document.getElementById('confirmDate').textContent    = formatted;
  goToStep(5);
}

// Exposed for Playwright/integration testing only
window.__test = { drawLawnPolygons, clearDetectionOverlays, updateSqft };
