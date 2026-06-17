(async function () {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (!cfg.mapsKey) { console.error('Maps key missing'); return; }
    const s = document.createElement('script');
    // Pin to quarterly channel (3.64 or earlier) — DrawingManager removed in 3.65
    s.src = 'https://maps.googleapis.com/maps/api/js'
      + '?key=' + cfg.mapsKey
      + '&v=quarterly'
      + '&libraries=drawing,geometry,places'
      + '&loading=async'
      + '&callback=initMap';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  } catch (e) {
    console.error('Failed to load Maps config:', e);
  }
})();
