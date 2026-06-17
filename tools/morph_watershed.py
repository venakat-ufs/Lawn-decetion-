#!/usr/bin/env python3
import sys
import os
import json
import cv2
import numpy as np

# Usage: python tools/morph_watershed.py <input_png> [kernel=7] [min_area=300]

def detect_lawns(input_path, kernel_size=7, min_area=300, debug_dir=None):
    img = cv2.imread(input_path)
    if img is None:
        raise RuntimeError(f"failed to read {input_path}")
    orig = img.copy()
    h, w = img.shape[:2]

    # Convert to HSV and build a green mask (tuned for satellite imagery)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # broad green range
    lower = np.array([30, 30, 30])   # hue,sat,val
    upper = np.array([100, 255, 255])
    mask = cv2.inRange(hsv, lower, upper)

    # Additional filtering: remove very dark/bright non-grass
    # Use morphological opening to remove thin bridges
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    # Distance transform + watershed
    # Ensure background is 0 and foreground 255
    # Compute sure background
    sure_bg = cv2.dilate(opened, kernel, iterations=2)
    # Distance transform
    dist = cv2.distanceTransform(opened, cv2.DIST_L2, 5)
    # Normalize for debug
    dist_norm = cv2.normalize(dist, None, 0, 1.0, cv2.NORM_MINMAX)
    # Threshold to obtain markers
    _, sure_fg = cv2.threshold(dist, 0.4 * dist.max(), 255, 0)
    sure_fg = np.uint8(sure_fg)
    # Unknown region
    unknown = cv2.subtract(sure_bg, sure_fg)

    # Marker labelling
    num_markers, markers = cv2.connectedComponents(sure_fg)
    # Add 1 so that background is 1 not 0
    markers = markers + 1
    # Mark the unknown region with zero
    markers[unknown == 255] = 0

    # Watershed expects a 3-channel image
    ws_img = orig.copy()
    cv2.watershed(ws_img, markers)
    # markers now labels regions, with -1 for boundaries

    # Build region masks
    regions = {}
    for y in range(h):
        for x in range(w):
            m = markers[y, x]
            if m <= 1:  # background or boundary
                continue
            regions.setdefault(int(m), []).append((x, y))

    # Convert region pixel lists to contours / polygons
    polygons = []
    masks = []
    for label, pts in regions.items():
        if len(pts) < min_area:
            continue
        mask_region = np.zeros((h, w), dtype=np.uint8)
        for (x, y) in pts:
            mask_region[y, x] = 255
        # Find contours
        contours, _ = cv2.findContours(mask_region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        # Use largest contour
        c = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        # Simplify contour (approxPolyDP) and convex hull fallback
        eps = 0.01 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True)
        if len(approx) < 4:
            hull = cv2.convexHull(c)
            approx = hull
        poly = [(int(p[0][0]), int(p[0][1])) for p in approx]
        # Reduce points to max 16 by sampling if needed
        if len(poly) > 16:
            stride = int(np.ceil(len(poly) / 16.0))
            poly = [poly[i] for i in range(0, len(poly), stride)]
        polygons.append(poly)
        masks.append(mask_region)

    # If no polygons found, fallback to connected-components on opened mask
    if not polygons:
        num_labels, labels_im = cv2.connectedComponents(opened)
        for lbl in range(1, num_labels):
            mask_region = np.uint8(labels_im == lbl) * 255
            area = int(cv2.countNonZero(mask_region))
            if area < min_area:
                continue
            contours, _ = cv2.findContours(mask_region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            c = max(contours, key=cv2.contourArea)
            area = cv2.contourArea(c)
            if area < min_area:
                continue
            approx = cv2.approxPolyDP(c, 0.01 * cv2.arcLength(c, True), True)
            poly = [(int(p[0][0]), int(p[0][1])) for p in approx]
            polygons.append(poly)
            masks.append(mask_region)

    # Build overlay image for visualization
    overlay = orig.copy()
    # draw watershed boundaries
    overlay[markers == -1] = (0, 0, 255)
    # draw polygons
    for i, poly in enumerate(polygons):
        pts = np.array(poly, np.int32).reshape((-1, 1, 2))
        color = (0, 0, 255) if i == 0 else (0, 255, 0)
        cv2.polylines(overlay, [pts], True, color, 3)
        # fill with transparent color
        cv2.fillPoly(overlay, [pts], (0, 0, 255) if i == 0 else (0, 255, 0))

    result = {
        'input': os.path.basename(input_path),
        'width': w,
        'height': h,
        'polygons': polygons,
    }

    # save debug outputs if requested
    base_dir = debug_dir or os.path.dirname(input_path)
    mask_path = os.path.join(base_dir, 'mw-mask.png')
    overlay_path = os.path.join(base_dir, 'mw-overlay.png')
    json_path = os.path.join(base_dir, 'mw-polygons.json')

    cv2.imwrite(mask_path, opened)
    cv2.imwrite(overlay_path, overlay)
    with open(json_path, 'w') as f:
        json.dump(result, f, indent=2)

    return result, mask_path, overlay_path, json_path

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python tools/morph_watershed.py <input_png> [kernel=7] [min_area=300]')
        sys.exit(1)
    inp = sys.argv[1]
    kernel = int(sys.argv[2]) if len(sys.argv) >= 3 else 7
    min_area = int(sys.argv[3]) if len(sys.argv) >= 4 else 300
    try:
        res = detect_lawns(inp, kernel, min_area)
        print('Done. polygons:', len(res[0]['polygons']))
        print('mask ->', res[1])
        print('overlay ->', res[2])
        print('json ->', res[3])
    except Exception as e:
        print('ERROR', e)
        sys.exit(2)
