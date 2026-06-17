const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// Usage: node tools/split-large-components.js <input-png>
(async function(){
  try {
    const input = process.argv[2] || 'test-screenshots/ml-03-two-polygons.png';
    const p = path.resolve(__dirname, '..', input);
    if (!fs.existsSync(p)) { console.error('Input not found:', p); process.exit(2); }

    const buf = fs.readFileSync(p);
    const png = PNG.sync.read(buf);
    const { width, height, data } = png;
    console.log('Loaded', input, width + 'x' + height);

    const mask = new Uint8Array(width * height);
    const seeds = [];
    for (let y=0;y<height;y++){
      for (let x=0;x<width;x++){
        const idx=(y*width+x)*4; const r=data[idx], g=data[idx+1], b=data[idx+2];
        const brightness=(r+g+b)/3; const greenDominance=g-Math.max(r,b); const excessGreen=(2*g)-r-b;
        const looksLikeGreen = (g>=72 && greenDominance>=8 && excessGreen>=18 && brightness>=42) || (g>=54 && greenDominance>=5 && excessGreen>=14 && brightness>=35);
        if (looksLikeGreen){ mask[y*width + x]=1; seeds.push({x,y}); }
      }
    }
    console.log('Seeds', seeds.length);

    const visited = new Uint8Array(width*height);
    const components = [];
    const neighbors = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    for (const s of seeds){ const si=s.y*width+s.x; if (visited[si]) continue; const q=[s]; visited[si]=1; const comp=[]; while(q.length){ const c=q.pop(); comp.push(c); for(const [dx,dy] of neighbors){ const nx=c.x+dx, ny=c.y+dy; if(nx<0||ny<0||nx>=width||ny>=height) continue; const ni=ny*width+nx; if(visited[ni]||!mask[ni]) continue; visited[ni]=1; q.push({x:nx,y:ny}); } } if(comp.length>=25) components.push(comp); }
    console.log('Components found:', components.length);

    // find large components
    const large = components.filter(c=>c.length>1000);
    console.log('Large components (>1000 px):', large.length);
    function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }

    // simple DBSCAN
    function dbscan(points, eps=40, minPts=50){
      const n=points.length; const labels=new Array(n).fill(0); let C=0;
      function regionQuery(i){ const res=[]; for(let j=0;j<n;j++){ if(dist(points[i], points[j])<=eps) res.push(j); } return res; }
      for(let i=0;i<n;i++){ if(labels[i]!=0) continue; const nbrs=regionQuery(i); if(nbrs.length<minPts){ labels[i]=-1; continue;} C++; const stack=[...nbrs]; labels[i]=C; while(stack.length){ const j=stack.pop(); if(labels[j]==-1) labels[j]=C; if(labels[j]!=0) continue; labels[j]=C; const nbrs2=regionQuery(j); if(nbrs2.length>=minPts) stack.push(...nbrs2); } }
      return labels;
    }

    const results = [];
    for(const comp of large){ console.log('Splitting component size', comp.length); const labels=dbscan(comp, 40, 40); const clusters={}; for(let i=0;i<labels.length;i++){ const lab=labels[i]; if(lab>0){ clusters[lab]=clusters[lab]||[]; clusters[lab].push(comp[i]); } }
      console.log(' DBSCAN clusters:', Object.keys(clusters).length);
      // compute convex hull per cluster
      function cross(a,b,c){ return (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x); }
      function convexHull(points){ if(points.length<=3) return points; const pts=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y); const lower=[]; for(const p of pts){ while(lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p)<=0) lower.pop(); lower.push(p);} const upper=[]; for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p)<=0) upper.pop(); upper.push(p);} upper.pop(); lower.pop(); return lower.concat(upper); }
      const polys = Object.values(clusters).map(c=>convexHull(c).map(p=>({x:Math.round(p.x),y:Math.round(p.y)}))).filter(p=>p.length>=3);
      results.push({ originalSize: comp.length, clusters: Object.keys(clusters).length, polygons: polys });
    }

    const out = { components: components.length, large: results.length, results };
    const outPath = path.resolve(path.dirname(p),'split-results.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log('Wrote', outPath);
  } catch(e){ console.error(e); process.exit(1); }
})();
