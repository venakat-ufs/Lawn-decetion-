/**
 * Debug Sherman Oaks detection — captures server logs + API response
 * Run: node debug-sherman.js
 */

const { spawn } = require('child_process');
const http = require('http');

const LAT = 34.1734522;
const LNG = -118.4370093;

function startServer() {
  const logs = [];
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  srv.stdout.on('data', d => { process.stdout.write('[srv] ' + d); logs.push(d.toString()); });
  srv.stderr.on('data', d => { process.stderr.write('[srv-err] ' + d); });
  return new Promise(resolve => {
    let buf = '';
    srv.stdout.on('data', d => {
      buf += d;
      if (buf.includes('running at')) resolve({ srv, logs });
    });
    setTimeout(() => resolve({ srv, logs }), 5000);
  });
}

function callAPI(lat, lng) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ lat, lng });
    const req = http.request({
      hostname: 'localhost', port: 3001, path: '/api/detect-lawn', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

(async () => {
  console.log('Starting server…');
  const { srv, logs } = await startServer();
  console.log('Server up. Calling detect-lawn for Sherman Oaks…\n');

  try {
    // First call — no parcel boundary (raw green-seg only)
    console.log('═══ CALL 1: No parcel boundary (pure green-seg path) ═══');
    const r1 = await callAPI(LAT, LNG);
    console.log('\n--- API Response (no parcel) ---');
    console.log('polygons:', r1.lawn_polygons?.length);
    console.log('confidence:', r1.confidence);
    console.log('source:', r1.source);
    if (r1.lawn_polygons?.length) {
      r1.lawn_polygons.forEach((p, i) => {
        const xs = p.map(v => v.x), ys = p.map(v => v.y);
        console.log('poly[' + i + ']: ' + p.length + ' pts, bbox x=' + Math.min(...xs) + '-' + Math.max(...xs) + ' y=' + Math.min(...ys) + '-' + Math.max(...ys));
      });
    }

    await new Promise(r => setTimeout(r, 1000));

    // Second call — with parcel boundary (GPT path)
    // Use a rough bounding box around the Sherman Oaks property as simulated parcel
    console.log('\n═══ CALL 2: With parcel boundary ═══');
    const boundary = [
      { lat: LAT + 0.0008, lng: LNG - 0.0010 },
      { lat: LAT + 0.0008, lng: LNG + 0.0010 },
      { lat: LAT - 0.0008, lng: LNG + 0.0010 },
      { lat: LAT - 0.0008, lng: LNG - 0.0010 },
    ];
    const r2 = await callAPIWithParcel(LAT, LNG, boundary);
    console.log('\n--- API Response (with parcel) ---');
    console.log('polygons:', r2.lawn_polygons?.length);
    console.log('confidence:', r2.confidence);
    console.log('source:', r2.source);
    if (r2.lawn_polygons?.length) {
      r2.lawn_polygons.forEach((p, i) => {
        const xs = p.map(v => v.x), ys = p.map(v => v.y);
        console.log('poly[' + i + ']: ' + p.length + ' pts, bbox x=' + Math.min(...xs) + '-' + Math.max(...xs) + ' y=' + Math.min(...ys) + '-' + Math.max(...ys));
      });
    }

  } finally {
    srv.kill();
    console.log('\nServer stopped.');
  }
})();

function callAPIWithParcel(lat, lng, parcelBoundary) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ lat, lng, parcel_boundary: parcelBoundary, parcel_source: 'test' });
    const req = http.request({
      hostname: 'localhost', port: 3001, path: '/api/detect-lawn', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
