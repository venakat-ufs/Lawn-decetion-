# Progress Log — UFS Lawn Mowing Quote Tool

Last updated: 2026-06-16

## Summary

Full-stack lawn mowing quote tool for United Field Services. Users enter an address, see a satellite map, auto-detect their lawn via GPT-4o + green segmentation, and get a pricing quote.

---

## Completed

### Core App
- `index.html` / `app.js` / `style.css` — full 3-step UI (address → map → quote)
- `loader.js` — loads Google Maps API key securely from `/api/config`
- `server.js` — local dev server (static files + API proxy)

### Detection Pipeline (`server.js` + `api/detect-lawn.js`)
1. Fetch parcel boundary from LA County GIS → Regrid fallback
2. Run green pixel segmentation on Static Maps image (640×640 zoom 20)
3. Pass bright, smooth patch locations as spatial hints to GPT-4o
4. GPT-4o draws polygon(s) around visible lawn areas
5. **Sutherland-Hodgman clipping** — clip every GPT polygon to parcel boundary
6. **Per-polygon validation** — filter polygons with < 35% green coverage or texture > 18 (tree canopy)
7. **Green-seg fallback** — if GPT returns nothing valid, use segmentation polygons (brightness 65-185, texture ≤ 18)
8. **Supplemental** — add any uncovered bright green patches that GPT missed

### Key algorithm tuning
- Texture threshold: ≤ 18 (grass ≈ 10–14, trees ≈ 18–35 per TGDI 2019)
- Brightness filter: 65–185 in all paths — excludes anomalously bright areas (artificial turf, rock gardens)
- Minimum area: 100 sq ft to filter satellite noise

### Vercel deployment
- `api/config.js`, `api/detect-lawn.js`, `api/parcel-boundary.js`, `api/export-map.js` — serverless functions
- `vercel.json` — routes API calls to serverless functions, serves static files

### Testing
- `test-3props.js` — Playwright end-to-end test on 3 properties
- `debug-visualize.js`, `debug-mask.js`, `debug-sherman.js` — diagnostic overlays

---

## Test Results (2026-06-16)

| Property | Polygons | Sq Ft | Source |
|---|---|---|---|
| 5643 Colbath Ave, Sherman Oaks | 0 | 0 | No lawn detected (correct — pool/trees only) |
| 1012 N Sunset Canyon Dr, Burbank | 2 | 751 | Green segmentation |
| 6149 Auckland Ave, North Hollywood | 2 | 1,217 | AI detected (GPT-4o) |

---

## Next Steps

- [ ] Vercel deployment — set env vars (`OPENAI_API_KEY`, `GOOGLE_MAPS_API_KEY`, `REGRID_API_KEY`)
- [ ] Test deployed URL on all 3 properties
- [ ] Add more test properties from different LA neighborhoods
