#!/usr/bin/env python3
import subprocess, os, sys, json

ML03 = "test-screenshots/ml-03-two-polygons.png"
REAL02 = "test-screenshots/real-02-map.png"
BASE_DIR = os.path.dirname(os.path.dirname(__file__))

def run_multi(img, min_area=500, large_thresh=800):
    cmd = [sys.executable, os.path.join(BASE_DIR, 'tools', 'multi_scale_split.py'), img, str(min_area), str(large_thresh)]
    print('Running:', ' '.join(cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print('Error:', res.stderr)
        return False
    return True

def count_polygons(jsonpath):
    if not os.path.exists(jsonpath): return 0
    with open(jsonpath,'r') as f:
        d = json.load(f)
    return len(d.get('polygons', []))

def run_merge(jsonpath, imagepath, fraction):
    cmd = [sys.executable, os.path.join(BASE_DIR,'tools','merge_small_polygons.py'), jsonpath, imagepath, str(fraction)]
    print('Merging with fraction', fraction)
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout)
    return res.returncode == 0


def main():
    fractions = [0.12, 0.10, 0.08, 0.06, 0.04, 0.02]
    # initial run on ML03
    for frac in fractions:
        ok = run_multi(ML03, 500, 800)
        if not ok:
            print('multi-scale failed')
            sys.exit(1)
        jsonpath = os.path.join(os.path.dirname(ML03), 'ms-polygons.json')
        if not os.path.exists(jsonpath):
            print('json not found', jsonpath); sys.exit(1)
        # merge
        run_merge(jsonpath, ML03, frac)
        merged_json = os.path.splitext(jsonpath)[0] + '-merged.json'
        count = count_polygons(merged_json)
        print('ML03 polygons after merge:', count)
        if count == 2:
            print('Success for ML03 with fraction', frac)
            # verify real02 not over-merged
            ok = run_multi(REAL02, 500, 800)
            if not ok: sys.exit(1)
            json_real = os.path.join(os.path.dirname(REAL02), 'ms-polygons.json')
            run_merge(json_real, REAL02, frac)
            merged_real = os.path.splitext(json_real)[0] + '-merged.json'
            real_count = count_polygons(merged_real)
            print('REAL02 polygons after merge:', real_count)
            if real_count >= 10:
                print('Acceptable on REAL02')
                print('Done. fraction=', frac)
                return
            else:
                print('REAL02 too merged, continue searching')
                continue
    print('Unable to find fraction achieving exact 2 polygons without over-merging')

if __name__ == '__main__':
    main()
