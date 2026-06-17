#!/usr/bin/env python3
import sys, os, json
import numpy as np
import cv2

# Usage: python tools/merge_small_polygons.py <ms-polygons.json> <image_png> [fraction=0.12]

def poly_area(poly):
    # poly: list of [x,y]
    if not poly: return 0
    a = 0
    n = len(poly)
    for i in range(n):
        x1,y1 = poly[i]
        x2,y2 = poly[(i+1)%n]
        a += x1*y2 - x2*y1
    return abs(a)/2

def centroid(poly):
    if not poly: return (0,0)
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return (sum(xs)/len(xs), sum(ys)/len(ys))

def convex_hull_from_points(pts):
    # pts: list of (x,y)
    if len(pts) == 0:
        return []
    arr = np.array(pts, dtype=np.int32)
    if arr.shape[0] == 1:
        return [tuple(arr[0])]
    hull = cv2.convexHull(arr)
    return [ (int(p[0][0]), int(p[0][1])) for p in hull ]

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python tools/merge_small_polygons.py <ms-polygons.json> <image_png> [fraction=0.12]')
        sys.exit(1)
    jsonp = sys.argv[1]
    imagep = sys.argv[2]
    fraction = float(sys.argv[3]) if len(sys.argv) >= 4 else 0.12

    with open(jsonp, 'r') as f:
        data = json.load(f)
    polys = data.get('polygons', [])
    if not polys:
        print('No polygons found in', jsonp)
        sys.exit(0)

    areas = [poly_area(p) for p in polys]
    largest = max(areas) if areas else 0
    thresh = largest * fraction
    print('Loaded', len(polys), 'polygons. largest area=', largest, 'merge threshold=', thresh)

    # iterative merge: find polygons with area < thresh and merge into nearest large poly
    merged = polys.copy()
    changed = True
    while changed:
        areas = [poly_area(p) for p in merged]
        largest = max(areas) if areas else 0
        thresh = largest * fraction
        small_idxs = [i for i,a in enumerate(areas) if a < thresh]
        changed = False
        if not small_idxs:
            break
        # for each small index, merge
        for idx in sorted(small_idxs, reverse=True):
            if idx >= len(merged):
                continue
            small = merged.pop(idx)
            # find nearest polygon by centroid
            csmall = centroid(small)
            best_j = None
            best_d = float('inf')
            for j,p in enumerate(merged):
                cj = centroid(p)
                d = (cj[0]-csmall[0])**2 + (cj[1]-csmall[1])**2
                if d < best_d:
                    best_d = d
                    best_j = j
            if best_j is None:
                # no other poly, keep it
                merged.append(small)
                continue
            # merge points and compute convex hull
            pts = merged[best_j] + small
            hull = convex_hull_from_points(pts)
            merged[best_j] = hull
            changed = True
            print('Merged small poly', idx, 'into', best_j)
            # break to recompute areas
            break
    print('Resulting polygons:', len(merged))

    # save overlay
    img = cv2.imread(imagep)
    overlay = img.copy()
    for i,p in enumerate(merged):
        if not p: continue
        pts = np.array(p).reshape((-1,1,2)).astype(np.int32)
        color = (0,255,0) if i==0 else (255,0,0)
        cv2.polylines(overlay, [pts], True, color, 2)
        cv2.fillPoly(overlay, [pts], (0,255,0,50))
    out_json = {'input': data.get('input',''), 'width': data.get('width'), 'height': data.get('height'), 'polygons': merged}
    out_json_path = os.path.splitext(jsonp)[0] + '-merged.json'
    out_overlay_path = os.path.splitext(imagep)[0] + '-merged-overlay.png'
    with open(out_json_path, 'w') as f:
        json.dump(out_json, f, indent=2)
    cv2.imwrite(out_overlay_path, overlay)
    print('Wrote', out_json_path, out_overlay_path)
