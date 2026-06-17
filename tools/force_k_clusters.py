#!/usr/bin/env python3
import sys, os, json
import numpy as np
import cv2

# Usage: python tools/force_k_clusters.py <ms-polygons.json> <image> <k=2>

def centroid(poly):
    xs=[p[0] for p in poly]
    ys=[p[1] for p in poly]
    return (sum(xs)/len(xs), sum(ys)/len(ys))

def convex_hull_from_points(pts):
    if not pts: return []
    arr=np.array(pts, dtype=np.int32)
    if arr.shape[0]==1:
        return [(int(arr[0][0]), int(arr[0][1]))]
    hull=cv2.convexHull(arr)
    return [ (int(p[0][0]), int(p[0][1])) for p in hull ]

if __name__=='__main__':
    if len(sys.argv)<3:
        print('Usage: python tools/force_k_clusters.py <ms-polygons.json> <image> [k=2]')
        sys.exit(1)
    jpath=sys.argv[1]
    imgpath=sys.argv[2]
    k=int(sys.argv[3]) if len(sys.argv)>=4 else 2
    with open(jpath) as f: data=json.load(f)
    polys=data.get('polygons',[])
    if not polys:
        print('No polygons')
        sys.exit(0)
    cents=[centroid(p) for p in polys]
    pts=np.array(cents, dtype=np.float32)
    if pts.shape[0] < k:
        print('Less polygons than k; saving original')
        out=jpath.replace('.json','-clustered.json')
        with open(out,'w') as f: json.dump(data,f,indent=2)
        sys.exit(0)
    # kmeans
    crit=(cv2.TERM_CRITERIA_EPS+cv2.TERM_CRITERIA_MAX_ITER,100,0.2)
    flags=cv2.KMEANS_PP_CENTERS
    _, labels, centers = cv2.kmeans(pts, k, None, crit, 10, flags)
    labels = labels.flatten()
    clusters=[[] for _ in range(k)]
    for i,lab in enumerate(labels):
        clusters[lab].extend(polys[i])
    merged=[]
    for c in clusters:
        hull=convex_hull_from_points(c)
        if hull:
            merged.append(hull)
    out_data={'input':data.get('input',''),'width':data.get('width'),'height':data.get('height'),'polygons':merged}
    out_json=jpath.replace('.json','-clustered.json')
    with open(out_json,'w') as f: json.dump(out_data,f,indent=2)
    # overlay
    img=cv2.imread(imgpath)
    overlay=img.copy()
    colors=[(0,255,0),(0,0,255),(255,0,0),(0,255,255)]
    for i,p in enumerate(merged):
        pts=np.array(p).reshape((-1,1,2)).astype(np.int32)
        col=colors[i%len(colors)]
        cv2.polylines(overlay,[pts],True,col,3)
    out_overlay=imgpath.replace('.png','-clustered-overlay.png')
    cv2.imwrite(out_overlay, overlay)
    print('Wrote', out_json, out_overlay)
