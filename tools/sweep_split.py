#!/usr/bin/env python3
import os, sys, json, subprocess, tempfile
from pathlib import Path
import cv2
import numpy as np

# This script runs parameter sweep for the multi-scale splitting algorithm
# It imports the core functions from multi_scale_split.py by executing it as a module
# but to keep things simple, we'll reimplement the core logic here with kernel list param.

import cv2

def green_mask_hsv(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lower = np.array([30, 30, 30])
    upper = np.array([100, 255, 255])
    mask = cv2.inRange(hsv, lower, upper)
    return mask

def contour_count_on_mask(mask, min_area):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    for c in contours:
        area = cv2.contourArea(c)
        if area >= min_area:
            polys.append(c)
    return len(polys), polys

# reuse watershed_split and kmeans_split from the other script -- copy small helpers

def watershed_split_on_mask(component_mask, orig_img, klist, min_area):
    # try sequential kernels in klist
    for ksize in klist:
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))
        opened = cv2.morphologyEx(component_mask, cv2.MORPH_OPEN, ker)
        sure_bg = cv2.dilate(opened, ker, iterations=2)
        dist = cv2.distanceTransform(opened, cv2.DIST_L2, 5)
        if dist.max() <= 1e-6:
            continue
        _, sure_fg = cv2.threshold(dist, 0.4 * dist.max(), 255, 0)
        sure_fg = np.uint8(sure_fg)
        unknown = cv2.subtract(sure_bg, sure_fg)
        num_markers, markers = cv2.connectedComponents(sure_fg)
        markers = markers + 1
        markers[unknown==255] = 0
        ws_img = cv2.cvtColor(orig_img, cv2.COLOR_BGR2RGB).copy()
        try:
            cv2.watershed(ws_img, markers)
        except Exception:
            continue
        regions = {}
        h,w = component_mask.shape
        for y in range(h):
            for x in range(w):
                m = markers[y,x]
                if m <= 1: continue
                regions.setdefault(int(m), []).append((x,y))
        polys = []
        for m, pts in regions.items():
            if len(pts) < min_area: continue
            rm = np.zeros_like(component_mask)
            for (x,y) in pts: rm[y,x]=255
            ncont, clist = contour_count_on_mask(rm, min_area)
            if ncont>0:
                polys.append((m, ncont))
        if len(polys) > 1:
            return True, len(polys)
    return False, 1


def evaluate_params(img_path, klist, min_area, large_thresh, small_poly_thresh=300):
    img = cv2.imread(img_path)
    mask = green_mask_hsv(img)
    init_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5,5))
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, init_kernel)
    # connected components
    num, labels = cv2.connectedComponents(opened)
    total_polys = 0
    small_polys = 0
    polys_details = []
    for lbl in range(1, num):
        comp_mask = (labels==lbl).astype('uint8')*255
        area = int(cv2.countNonZero(comp_mask))
        if area < min_area: continue
        if area < large_thresh:
            ncont, clist = contour_count_on_mask(comp_mask, min_area)
            total_polys += ncont
            # count small ones
            if ncont>0:
                # compute area of each contour
                contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for c in contours:
                    a = cv2.contourArea(c)
                    if a >= min_area:
                        if a < small_poly_thresh: small_polys += 1
            continue
        # large component: try watershed split
        split, nsplit = watershed_split_on_mask(comp_mask, img, klist, min_area)
        if split:
            total_polys += nsplit
            # small poly count naive: assume each split >= min_area
        else:
            # fallback count contours
            ncont, _ = contour_count_on_mask(comp_mask, min_area)
            total_polys += ncont
    return total_polys, small_polys


def run_sweep(img_ml03, img_real02):
    kernel_options = [[11,15],[11,15,21],[7,11,15],[15,21]]
    min_area_options = [100,300,500]
    large_thresh_options = [800,1200,2000]
    best = None
    results = []
    for klist in kernel_options:
        for min_area in min_area_options:
            for large in large_thresh_options:
                mp, sp = evaluate_params(img_ml03, klist, min_area, large)
                rp, rsp = evaluate_params(img_real02, klist, min_area, large)
                # score: prefer ml03 total_polys close to 2, penalize small polys in real
                score = abs(mp - 2) * 100 + sp + rsp*0.01
                rec = {'klist':klist, 'min_area':min_area, 'large_thresh':large,
                       'ml03_polys':mp, 'ml03_small':sp, 'real_polys':rp, 'real_small':rsp, 'score':score}
                results.append(rec)
                if best is None or score < best['score']:
                    best = rec
    return best, results

if __name__=='__main__':
    if len(sys.argv) < 3:
        print('Usage: python tools/sweep_split.py <ml03_png> <real02_png>')
        sys.exit(1)
    ml = sys.argv[1]
    real = sys.argv[2]
    best, allres = run_sweep(ml, real)
    outp = 'sweep-result.json'
    with open(outp, 'w') as f: json.dump({'best':best, 'results':allres}, f, indent=2)
    print('Wrote', outp)
    print('Best:', best)