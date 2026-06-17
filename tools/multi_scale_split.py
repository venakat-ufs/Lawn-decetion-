#!/usr/bin/env python3
import sys, os, json
import cv2
import numpy as np

# Usage: python tools/multi_scale_split.py <input_png> [min_area=300] [large_thresh=1200]

def green_mask_hsv(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lower = np.array([30, 30, 30])
    upper = np.array([100, 255, 255])
    mask = cv2.inRange(hsv, lower, upper)
    return mask

def connected_components_masks(bin_mask):
    num, labels = cv2.connectedComponents(bin_mask)
    comps = []
    for lbl in range(1, num):
        comp_mask = (labels == lbl).astype('uint8') * 255
        comps.append((lbl, comp_mask))
    return comps

def contour_polygon_from_mask(mask, min_area=300, max_points=16):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c)
    if area < min_area:
        return None
    eps = 0.01 * cv2.arcLength(c, True)
    approx = cv2.approxPolyDP(c, eps, True)
    if len(approx) < 4:
        approx = cv2.convexHull(c)
    poly = [(int(p[0][0]), int(p[0][1])) for p in approx]
    if len(poly) > max_points:
        stride = int(np.ceil(len(poly)/max_points))
        poly = [poly[i] for i in range(0, len(poly), stride)]
    return poly

def watershed_split(component_mask, orig_img, min_area=300):
    # component_mask: uint8 0/255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7,7))
    opened = cv2.morphologyEx(component_mask, cv2.MORPH_OPEN, kernel)
    sure_bg = cv2.dilate(opened, kernel, iterations=2)
    dist = cv2.distanceTransform(opened, cv2.DIST_L2, 5)
    if dist.max() <= 1e-6:
        return []
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
        return []
    regions = {}
    h,w = component_mask.shape
    for y in range(h):
        for x in range(w):
            m = markers[y,x]
            if m <= 1:
                continue
            regions.setdefault(int(m), []).append((x,y))
    polys = []
    for m, pts in regions.items():
        if len(pts) < min_area:
            continue
        # make mask
        rm = np.zeros_like(component_mask)
        for (x,y) in pts:
            rm[y,x] = 255
        poly = contour_polygon_from_mask(rm, min_area=min_area)
        if poly:
            polys.append(poly)
    return polys

def kmeans_split(component_mask, k=2, min_area=300):
    ys, xs = np.where(component_mask>0)
    if len(xs) == 0:
        return []
    pts = np.column_stack((xs, ys)).astype(np.float32)
    if len(pts) < k:
        return []
    flags = cv2.KMEANS_PP_CENTERS
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1.0)
    _, labels, centers = cv2.kmeans(pts, k, None, crit, 3, flags)
    polys = []
    for cluster in range(k):
        cluster_pts = pts[labels.flatten()==cluster].astype(int)
        if len(cluster_pts) < min_area:
            continue
        mask = np.zeros_like(component_mask)
        for (x,y) in cluster_pts:
            mask[y,x] = 255
        poly = contour_polygon_from_mask(mask, min_area=min_area)
        if poly:
            polys.append(poly)
    return polys


def multi_scale_split(img_path, min_area=300, large_thresh=1200, debug_dir=None):
    img = cv2.imread(img_path)
    if img is None:
        raise RuntimeError('failed to read '+img_path)
    h,w = img.shape[:2]
    mask = green_mask_hsv(img)
    # initial opening to remove noise
    init_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5,5))
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, init_kernel)
    comps = connected_components_masks(opened)
    final_polys = []
    overlay = img.copy()

    for (lbl, comp_mask) in comps:
        area = int(cv2.countNonZero(comp_mask))
        if area < min_area:
            continue
        if area < large_thresh:
            poly = contour_polygon_from_mask(comp_mask, min_area=min_area)
            if poly:
                final_polys.append(poly)
                cv2.polylines(overlay, [np.array(poly).reshape((-1,1,2))], True, (0,255,0), 2)
            continue
        # large component: try multi-scale openings
        split_polys = []
        tried = False
        for ksize in [11, 15, 21]:
            ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))
            cleaned = cv2.morphologyEx(comp_mask, cv2.MORPH_OPEN, ker)
            # if cleaned becomes empty, skip
            if cv2.countNonZero(cleaned) < min_area:
                continue
            # attempt watershed on cleaned mask
            polys = watershed_split(cleaned, img, min_area=min_area)
            if len(polys) > 1:
                split_polys = polys
                tried = True
                break
        if not tried:
            # fallback kmeans attempts k=2..4
            for k in range(2,5):
                polys = kmeans_split(comp_mask, k=k, min_area=min_area)
                if len(polys) > 1:
                    split_polys = polys
                    tried = True
                    break
        if split_polys:
            for poly in split_polys:
                final_polys.append(poly)
                cv2.polylines(overlay, [np.array(poly).reshape((-1,1,2))], True, (255,0,0), 2)
        else:
            # fallback keep as single
            poly = contour_polygon_from_mask(comp_mask, min_area=min_area)
            if poly:
                final_polys.append(poly)
                cv2.polylines(overlay, [np.array(poly).reshape((-1,1,2))], True, (0,255,0), 2)

    # save outputs
    base_dir = debug_dir or os.path.dirname(img_path)
    mask_path = os.path.join(base_dir, 'ms-mask.png')
    overlay_path = os.path.join(base_dir, 'ms-overlay.png')
    json_path = os.path.join(base_dir, 'ms-polygons.json')
    # save mask visualization (opened mask)
    cv2.imwrite(mask_path, opened)
    cv2.imwrite(overlay_path, overlay)
    out = {'input': os.path.basename(img_path), 'width': w, 'height': h, 'polygons': final_polys}
    with open(json_path, 'w') as f:
        json.dump(out, f, indent=2)
    return out, mask_path, overlay_path, json_path

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python tools/multi_scale_split.py <input_png> [min_area=300] [large_thresh=1200]')
        sys.exit(1)
    imgp = sys.argv[1]
    min_area = int(sys.argv[2]) if len(sys.argv) >= 3 else 300
    large_thresh = int(sys.argv[3]) if len(sys.argv) >= 4 else 1200
    res = multi_scale_split(imgp, min_area=min_area, large_thresh=large_thresh)
    print('Done. polygons:', len(res[0]['polygons']))
    print('mask ->', res[1])
    print('overlay ->', res[2])
    print('json ->', res[3])