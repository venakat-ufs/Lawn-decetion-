/**
 * Fetches the static map, draws the parcel boundary + detected polygon,
 * and saves a debug PNG. Run: node debug-visualize.js
 */

const { spawn } = require('child_process');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { PNG } = require('pngjs');

const LAT = 34.1734522;
const LNG = -118.4370093;

// ── draw a polygon on PNG (thin line, given color) ────────────────────────────
function drawPoly(png, polygon, r, g, b) {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b_ = polygon[(i + 1) % n];
    // Bresenham line
    let x0 = Math.round(a.x), y0 = Math.round(a.y);
    let x1 = Math.round(b_.x), y1 = Math.round(b_.y);
    const dx = Math.abs(x1-x0), dy = -Math.abs(y1-y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
      for (let t = -2; t <= 2; t++) {
        for (let u = -2; u <= 2; u++) {
          const px = x0+t, py = y0+u;
          if (px >= 0 && py >= 0 && px < png.width && py < png.height) {
            const idx = (py * png.width + px) * 4;
            png.data[idx] = r; png.data[idx+1] = g; png.data[idx+2] = b; png.data[idx+3] = 255;
          }
        }
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
}

function startServer() {
  const logs = [];
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  srv.stdout.on('data', d => { const s = d.toString(); logs.push(s); });
  srv.stderr.on('data', () => {});
  return new Promise(resolve => {
    let buf = '';
    srv.stdout.on('data', d => { buf += d; if (buf.includes('running at')) resolve({ srv, logs }); });
    setTimeout(() => resolve({ srv, logs }), 5000);
  });
}

function callDetect(lat, lng) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ lat, lng });
    const req = http.request({
      hostname:'localhost', port:3001, path:'/api/detect-lawn', method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function fetchStaticMap(lat, lng, key) {
  const url = 'https://maps.googleapis.com/maps/api/staticmap?center=' + lat + ',' + lng
    + '&zoom=20&size=640x640&maptype=satellite&key=' + key;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => resolve(Buffer.concat(bufs)));
    }).on('error', reject);
  });
}

function latLngToPixel(lat, lng, centerLat, centerLng, zoom, size) {
  const half = size / 2, scale = Math.pow(2, zoom);
  const worldX = ((centerLng + 180) / 360) * 256 * scale;
  const sinLat = Math.sin(centerLat * Math.PI / 180);
  const worldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 256 * scale;
  const targetX = ((lng + 180) / 360) * 256 * scale;
  const sinLat2 = Math.sin(lat * Math.PI / 180);
  const targetY = (0.5 - Math.log((1 + sinLat2) / (1 - sinLat2)) / (4 * Math.PI)) * 256 * scale;
  return { x: half + (targetX - worldX), y: half + (targetY - worldY) };
}

(async () => {
  const { srv, logs } = await startServer();
  console.log('Server up. Detecting…');

  try {
    const result = await callDetect(LAT, LNG);
    console.log('polygons:', result.lawn_polygons?.length, '| source:', result.source);
    console.log('parcel match:', result.parcel_match);

    // Pull MAPSKEY from env/server
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const mapsKey = envFile.match(/MAPS_API_KEY=(.+)/)?.[1]?.trim();
    if (!mapsKey) { console.log('No MAPS_API_KEY in .env'); return; }

    console.log('Fetching static map…');
    const imgBuf = await fetchStaticMap(LAT, LNG, mapsKey);
    const png    = PNG.sync.read(imgBuf);

    // Draw detected polygons (yellow)
    (result.lawn_polygons || []).forEach(poly => drawPoly(png, poly, 255, 230, 0));

    // Draw parcel boundary (red) if available
    if (result.debug_parcel_pixels && result.debug_parcel_pixels.length) {
      drawPoly(png, result.debug_parcel_pixels, 255, 60, 60);
    }

    // Mark property center (blue dot)
    const cx = 320, cy = 320;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const px = cx+dx, py = cy+dy;
      if (px>=0 && py>=0 && px<png.width && py<png.height) {
        const idx = (py*png.width+px)*4;
        png.data[idx]=0; png.data[idx+1]=100; png.data[idx+2]=255; png.data[idx+3]=255;
      }
    }

    const outPath = path.join(__dirname, 'test-screenshots', 'debug-sherman-overlay.png');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, PNG.sync.write(png));
    console.log('Saved overlay → test-screenshots/debug-sherman-overlay.png');

    // Print server logs
    console.log('\n=== SERVER LOGS ===');
    const allLogs = logs.join('');
    const relevant = allLogs.split('\n').filter(l => l.includes('[green-seg]') || l.includes('[gpt-filter]') || l.includes('[clip]') || l.includes('[comp-'));
    relevant.forEach(l => console.log(l));

  } finally {
    srv.kill();
  }
})();
