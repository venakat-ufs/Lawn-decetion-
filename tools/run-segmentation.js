const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// Usage: node tools/run-segmentation.js <input-png> [min_component_size]
(async function(){
  try {
    const input = process.argv[2] || 'test-screenshots/ml-03-two-polygons.png';
    const minSize = Number(process.argv[3]) || 25; // component pixel min
    const p = path.resolve(__dirname, '..', input);
    if (!fs.existsSync(p)) {
      console.error('Input not found:', p);
      process.exit(2);
    }

    const buf = fs.readFileSync(p);
    const png = PNG.sync.read(buf);
    const { width, height, data } = png;
    console.log('Loaded', input, width + 'x' + height);

    const mask = new Uint8Array(width * height);
    const seeds = [];

    function pointInParcel(x, y){
      // in these screenshots the parcel is entire image — caller may adapt
      return true;
    }

    for (let y=0;y<height;y++){
      for (let x=0;x<width;x++){
        if (!pointInParcel(x,y)) continue;
        const idx = (y*width + x) * 4;
        const r = data[idx];
        const g = data[idx+1];
        const b = data[idx+2];
        const brightness = (r+g+b)/3;
        const greenDominance = g - Math.max(r,b);
        const excessGreen = (2*g) - r - b;
        const looksLikeGreen =
          (g >= 72 && greenDominance >= 8 && excessGreen >= 18 && brightness >= 42) ||
          (g >= 54 && greenDominance >= 5 && excessGreen >= 14 && brightness >= 35);
        if (looksLikeGreen){
          mask[y*width + x] = 1;
          seeds.push({x,y,g,brightness,greenDominance,excessGreen});
        }
      }
    }

    console.log('Seed green pixels:', seeds.length);

    const visited = new Uint8Array(width * height);
    const components = [];
    const neighbors = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

    for (const seed of seeds){
      const si = seed.y*width + seed.x;
      if (visited[si]) continue;
      const queue = [seed];
      visited[si]=1;
      const comp = [];
      while (queue.length){
        const cur = queue.pop();
        comp.push(cur);
        for (const [dx,dy] of neighbors){
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          if (nx<0||ny<0||nx>=width||ny>=height) continue;
          const ni = ny*width + nx;
          if (visited[ni] || !mask[ni]) continue;
          visited[ni]=1;
          queue.push({x:nx,y:ny});
        }
      }
      if (comp.length >= minSize) components.push(comp);
    }

    console.log('Components found (>= ' + minSize + ' px):', components.length);

    // convex hull (monotone chain)
    function cross(a,b,c){ return (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x); }
    function convexHull(points){
      if (points.length<=3) return points.map(p=>({x:p.x,y:p.y}));
      const pts = points.map(p=>({x:p.x,y:p.y})).sort((a,b)=>a.x-b.x || a.y-b.y);
      const lower = [];
      for (const p of pts){
        while (lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p) <=0) lower.pop();
        lower.push(p);
      }
      const upper = [];
      for (let i=pts.length-1;i>=0;i--){
        const p=pts[i];
        while (upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p) <=0) upper.pop();
        upper.push(p);
      }
      upper.pop(); lower.pop();
      return lower.concat(upper);
    }

    function simplify(points, maxPoints=12){
      if (points.length<=maxPoints) return points;
      const stride = Math.ceil(points.length / maxPoints);
      const res = [];
      for (let i=0;i<points.length;i+=stride) res.push(points[i]);
      if (res[res.length-1] !== points[points.length-1]) res.push(points[points.length-1]);
      return res;
    }

    const polygons = components.map(comp => {
      const hull = convexHull(comp);
      const poly = hull.length>=3 ? simplify(hull, 12) : [];
      return poly.map(p=>({x: Math.round(p.x), y: Math.round(p.y)}));
    }).filter(p=>p.length>=3);

    // write mask PNG for visualization
    const outMask = new PNG({width, height});
    for (let y=0;y<height;y++){
      for (let x=0;x<width;x++){
        const i = (y*width + x);
        const idx = i*4;
        if (mask[i]){
          outMask.data[idx]=0; outMask.data[idx+1]=255; outMask.data[idx+2]=0; outMask.data[idx+3]=255;
        } else {
          outMask.data[idx]=0; outMask.data[idx+1]=0; outMask.data[idx+2]=0; outMask.data[idx+3]=30;
        }
      }
    }
    const maskPath = path.resolve(path.dirname(p), 'seg-mask.png');
    fs.writeFileSync(maskPath, PNG.sync.write(outMask));

    // save polygons JSON
    const outJson = {
      input: input,
      width, height,
      seeds: seeds.length,
      components: components.map(c=>c.length),
      polygons
    };
    const jsonPath = path.resolve(path.dirname(p), 'seg-polygons.json');
    fs.writeFileSync(jsonPath, JSON.stringify(outJson, null, 2));

    console.log('Saved mask ->', maskPath);
    console.log('Saved polygons ->', jsonPath);
    console.log('Polygons:', polygons.length);
    polygons.forEach((poly,i)=> console.log(' poly', i+1, 'pts', poly.length));

  } catch (e){
    console.error('ERROR', e);
    process.exit(1);
  }
})();
