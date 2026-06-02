/* =========================================================================
   United Field Services — Lawn Mowing Ad
   Google Maps polygon drawing + pricing logic
   Replace YOUR_GOOGLE_MAPS_API_KEY in index.html with a real key
   ========================================================================= */

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  address: '',
  latLng: null,
  sqft: 0,
  polygon: null,
  map: null,
  miniMap: null,
  miniPolygon: null,
  drawingManager: null,
  frequency: 'weekly',
};

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
  return max ? `$${min} – $${max}` : `From $${min}`;
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
        if (state.latLng) state.map.setCenter(state.latLng);
      }
    }, 150);
  }

  if (n === 3) renderEstimate();
  if (n === 4) renderBookingForm();
}
window.goToStep = goToStep;

// ── Step 1: address input ─────────────────────────────────────────────────────
function initStep1() {
  const input = document.getElementById('addressInput');
  const startBtn = document.getElementById('startBtn');
  const hint = document.getElementById('addrHint');

  // Google Places Autocomplete
  const autocomplete = new google.maps.places.Autocomplete(input, {
    types: ['address'],
    componentRestrictions: { country: 'us' },
  });

  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace();
    if (!place.geometry) return;
    state.address = place.formatted_address || input.value;
    state.latLng = place.geometry.location;
    hint.style.display = 'none';
  });

  startBtn.addEventListener('click', () => {
    if (!state.latLng) {
      hint.style.display = 'block';
      input.focus();
      return;
    }
    // Center map and go
    if (state.map) {
      state.map.setCenter(state.latLng);
      state.map.setZoom(19);
    }
    document.getElementById('mapAddressLabel').textContent = state.address;
    goToStep(2);
  });

  // Allow Enter key
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') startBtn.click();
  });
}

// ── Step 2: map + drawing ─────────────────────────────────────────────────────
function initMap() {
  // Main satellite map
  state.map = new google.maps.Map(document.getElementById('map'), {
    zoom: 19,
    mapTypeId: 'satellite',
    tilt: 0,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    rotateControl: false,
  });

  // Drawing manager
  state.drawingManager = new google.maps.drawing.DrawingManager({
    drawingMode: google.maps.drawing.OverlayType.POLYGON,
    drawingControl: false,
    polygonOptions: {
      fillColor: '#72262A',
      fillOpacity: 0.25,
      strokeColor: '#F0D8AA',
      strokeWeight: 2.5,
      editable: false,
      draggable: false,
      zIndex: 1,
    },
  });
  state.drawingManager.setMap(state.map);

  // When polygon is completed
  google.maps.event.addListener(state.drawingManager, 'polygoncomplete', polygon => {
    // Remove previous polygon
    if (state.polygon) state.polygon.setMap(null);
    state.polygon = polygon;

    // Calculate area
    updateSqft();

    // Listen for edits
    const path = polygon.getPath();
    path.addListener('set_at', updateSqft);
    path.addListener('insert_at', updateSqft);
    path.addListener('remove_at', updateSqft);

    // Switch back to non-drawing mode
    state.drawingManager.setDrawingMode(null);
    setActiveTool('editBtn');

    // Make editable
    polygon.setEditable(true);

    // Enable "Get Estimate" button
    document.getElementById('getEstimateBtn').disabled = false;
    document.getElementById('mapFooterHint').textContent = 'Drag the points to adjust your lawn outline';
  });

  // Init step 1 controls (autocomplete needs maps loaded)
  initStep1();
  initToolbar();
  initMapFooter();
}
window.initMap = initMap;

function updateSqft() {
  if (!state.polygon) return;
  const area = google.maps.geometry.spherical.computeArea(state.polygon.getPath());
  state.sqft = Math.round(area * 10.7639); // m² → sq ft
  const display = document.getElementById('sqftDisplay');
  if (display) display.textContent = 'Lawn size: ' + formatSqft(state.sqft);
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function setActiveTool(id) {
  document.querySelectorAll('.map-tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(id);
  if (btn) btn.classList.add('active');
}

function initToolbar() {
  document.getElementById('traceBtn').addEventListener('click', () => {
    if (state.polygon) { state.polygon.setMap(null); state.polygon = null; }
    state.drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    setActiveTool('traceBtn');
    document.getElementById('getEstimateBtn').disabled = true;
    document.getElementById('sqftDisplay').textContent = 'Draw your lawn to calculate size';
    document.getElementById('mapFooterHint').textContent = 'Click around your lawn outline. Double-click to finish.';
  });

  document.getElementById('editBtn').addEventListener('click', () => {
    state.drawingManager.setDrawingMode(null);
    if (state.polygon) state.polygon.setEditable(true);
    setActiveTool('editBtn');
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (!state.polygon) return;
    const path = state.polygon.getPath();
    if (path.getLength() > 0) {
      path.removeAt(path.getLength() - 1);
      updateSqft();
    }
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (state.polygon) { state.polygon.setMap(null); state.polygon = null; }
    state.drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    setActiveTool('traceBtn');
    document.getElementById('getEstimateBtn').disabled = true;
    document.getElementById('sqftDisplay').textContent = 'Draw your lawn to calculate size';
    document.getElementById('mapFooterHint').textContent = 'Trace your lawn area on the map above';
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
  const base = getBasePrice(state.sqft);
  const freq = document.querySelector('input[name="freq"]:checked')?.value || 'weekly';
  const priceStr = getDiscountedPrice(base, freq);

  document.getElementById('estimatePrice').textContent = priceStr;
  document.getElementById('estimateSqft').textContent = formatSqft(state.sqft);
  document.getElementById('estimateSqftStat').textContent = state.sqft.toLocaleString();
  document.getElementById('estimateAddress').textContent = state.address;

  // Frequency change updates price live
  document.querySelectorAll('input[name="freq"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const f = document.querySelector('input[name="freq"]:checked').value;
      document.getElementById('estimatePrice').textContent = getDiscountedPrice(base, f);
    });
  });

  // Mini map
  if (!state.miniMap) {
    state.miniMap = new google.maps.Map(document.getElementById('miniMap'), {
      zoom: 19,
      mapTypeId: 'satellite',
      tilt: 0,
      disableDefaultUI: true,
      gestureHandling: 'none',
    });
  }
  if (state.latLng) state.miniMap.setCenter(state.latLng);

  // Draw polygon on mini map
  if (state.miniPolygon) state.miniPolygon.setMap(null);
  if (state.polygon) {
    state.miniPolygon = new google.maps.Polygon({
      paths: state.polygon.getPath().getArray(),
      fillColor: '#72262A',
      fillOpacity: 0.30,
      strokeColor: '#F0D8AA',
      strokeWeight: 2,
      map: state.miniMap,
    });
  }

  setTimeout(() => google.maps.event.trigger(state.miniMap, 'resize'), 100);

  document.getElementById('bookNowBtn').onclick = () => goToStep(4);
}

// ── Step 4: booking form ──────────────────────────────────────────────────────
function renderBookingForm() {
  const freq = document.querySelector('input[name="freq"]:checked')?.value || 'weekly';
  const base = getBasePrice(state.sqft);
  const priceStr = getDiscountedPrice(base, freq);
  const freqLabels = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', 'one-time': 'One-time visit' };

  document.getElementById('summaryAddress').textContent = state.address || '—';
  document.getElementById('summarySqft').textContent = formatSqft(state.sqft);
  document.getElementById('summaryFreq').textContent = freqLabels[freq] || freq;
  document.getElementById('summaryPrice').textContent = priceStr;
  document.getElementById('bk-address').value = state.address || '';

  // Set min date to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  document.getElementById('bk-date').min = tomorrow.toISOString().split('T')[0];

  document.getElementById('bookingForm').onsubmit = e => {
    e.preventDefault();
    submitBooking(priceStr);
  };
}

function submitBooking(priceStr) {
  const date = document.getElementById('bk-date').value;
  const formatted = date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '—';

  document.getElementById('confirmAddress').textContent = state.address;
  document.getElementById('confirmPrice').textContent = priceStr;
  document.getElementById('confirmDate').textContent = formatted;

  goToStep(5);
}
