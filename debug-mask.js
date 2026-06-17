/**
 * Saves the static map + green-seg mask + parcel boundary as overlays.
 * Run: node debug-mask.js
 */

const { spawn } = require('child_process');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { PNG } = require('pngjs');

const LAT = 34.1734522;
const LNG = -118.4370093;

function drawPoly(png, polygon, r, g, b, thick) {
  thick = thick || 2;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b_ = polygon[(i + 1) % n];
    let x0 = Math.round(a.x), y0 = Math.round(a.y);
    let x1 = Math.round(b_.x), y1 = Math.round(b_.y);
    const dx = Math.abs(x1-x0), dy = -Math.abs(y1-y0);
    const sx = x0<x1?1:-1, sy = y0<y1?1:-1;
    let err = dx+dy;
    while (true) {
      for (let t=-thick;t<=thick;t++) for (let u=-thick;u<=thick;u++) {
        const px=x0+t, py=y0+u;
        if(px>=0&&py>=0&&px<png.width&&py<png.height){
          const idx=(py*png.width+px)*4;
          png.data[idx]=r;png.data[idx+1]=g;png.data[idx+2]=b;png.data[idx+3]=255;
        }
      }
      if(x0===x1&&y0===y1) break;
      const e2=2*err;
      if(e2>=dy){err+=dy;x0+=sx;}
      if(e2<=dx){err+=dx;y0+=sy;}
    }
  }
}

function startServer() {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'pipe' });
  srv.stderr.on('data', ()=>{});
  return new Promise(resolve => {
    let buf='';
    srv.stdout.on('data', d=>{ buf+=d; if(buf.includes('running at')) resolve(srv); });
    setTimeout(()=>resolve(srv), 5000);
  });
}

function callDetect(lat, lng) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ lat, lng, _debug_mask: true });
    const req = http.request({
      hostname:'localhost', port:3001, path:'/api/detect-lawn', method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
    }, res=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}

function fetchStaticMap(lat, lng, key) {
  const url = 'https://maps.googleapis.com/maps/api/staticmap?center='+lat+','+lng
    +'&zoom=20&size=640x640&maptype=satellite&key='+key;
  return new Promise((resolve, reject) => {
    https.get(url, res=>{ const bufs=[]; res.on('data',d=>bufs.push(d)); res.on('end',()=>resolve(Buffer.concat(bufs))); }).on('error',reject);
  });
}

(async () => {
  console.log('Starting server…');
  const srv = await startServer();
  console.log('Server up.');

  try {
    const result = await callDetect(LAT, LNG);
    console.log('polygons:', result.lawn_polygons?.length, '| source:', result.source);
    console.log('parcel pixels count:', result.debug_parcel_pixels?.length || 0);

    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const mapsKey = envFile.match(/MAPS_API_KEY=(.+)/)?.[1]?.trim();

    console.log('Fetching map image…');
    const imgBuf = await fetchStaticMap(LAT, LNG, mapsKey);
    const base = PNG.sync.read(imgBuf);

    // Build green-mask image: overlay green pixels in bright green on a darkened copy
    const masked = new PNG({ width: base.width, height: base.height });
    for (let i = 0; i < base.data.length; i += 4) {
      // Darken base image to 60%
      masked.data[i]   = Math.round(base.data[i]   * 0.5);
      masked.data[i+1] = Math.round(base.data[i+1] * 0.5);
      masked.data[i+2] = Math.round(base.data[i+2] * 0.5);
      masked.data[i+3] = 255;
      // Classify each pixel using same rules as server
      const r = base.data[i], g = base.data[i+1], b = base.data[i+2];
      const brightness = (r+g+b)/3;
      const greenDom = g - Math.max(r,b);
      const excessGreen = g - (r+b)/2;
      const isLikelyLawn = g>=72 && greenDom>=8 && excessGreen>=18 && brightness>=72;
      const isAnyGreen = (g>=72&&greenDom>=8&&excessGreen>=18&&brightness>=42) || (g>=54&&greenDom>=5&&excessGreen>=14&&brightness>=35);
      if (isLikelyLawn) {
        // Bright yellow-green for "likely lawn" pixels
        masked.data[i]   = 100;
        masked.data[i+1] = 255;
        masked.data[i+2] = 0;
        masked.data[i+3] = 255;
      } else if (isAnyGreen) {
        // Darker green for "any green" pixels
        masked.data[i]   = 0;
        masked.data[i+1] = 180;
        masked.data[i+2] = 0;
        masked.data[i+3] = 255;
      }
    }

    // Draw parcel boundary (red)
    if (result.debug_parcel_pixels?.length) {
      drawPoly(masked, result.debug_parcel_pixels, 255, 50, 50, 2);
    }

    // Draw detected polygons (yellow)
    for (const poly of (result.lawn_polygons||[])) {
      drawPoly(masked, poly, 255, 230, 0, 2);
    }

    // Blue center dot
    for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) {
      const px=320+dx, py=320+dy;
      if(px>=0&&py>=0&&px<640&&py<640){
        const idx=(py*640+px)*4;
        masked.data[idx]=0;masked.data[idx+1]=100;masked.data[idx+2]=255;masked.data[idx+3]=255;
      }
    }

    const outDir = path.join(__dirname, 'test-screenshots');
    fs.mkdirSync(outDir, {recursive:true});
    fs.writeFileSync(path.join(outDir, 'debug-green-mask.png'), PNG.sync.write(masked));
    console.log('Saved → test-screenshots/debug-green-mask.png');
    console.log('  Bright yellow-green = isLikelyLawn pixels');
    console.log('  Darker green = isAnyGreen pixels');
    console.log('  Red outline = parcel boundary');
    console.log('  Yellow outline = detected polygon');
    console.log('  Blue dot = property center');

  } finally {
    srv.kill();
  }
})();
