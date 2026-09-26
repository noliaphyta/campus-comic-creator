# Campus Comic Creator — Build Plan

## Motivation

Ground comic-style art in real place and time by generating backgrounds from historical archive photography instead of hand-drawn or 3D-modeled scenes. William & Mary's campus provides a bounded, discrete set of locations (named buildings, streets) and a deep photo record (Wikimedia Commons, the W&M Digital Archive, campus yearbooks), making it tractable to prototype a "photo → geolocated → dated → stylized → narrative" pipeline in a hackathon window.

The long-term shape of the idea is bigger than this build: a public map where anyone can contribute openly-licensed photos of a place and see them procedurally turned into comic-ready backgrounds. For the hackathon, this is narrowed to a fixed, curated dataset (no live submissions) driving one demoable narrative loop.

## Demo Goal

A judge should be able to walk through this in under two minutes: open the map, click 2–3 building pins in the order they want to visit, watch a walking route plot between them, then step through a short branching scene at each stop with a live-stylized background, ending in one of three epilogue variants shaped by their choices. See `docs/narrative-system.md` for how the story side of this works.

## Technical Architecture

**Single static web app. No backend, no database, no native app.** Every piece of data (photos, tags, coordinates, dates, story content) is authored once during prep day and shipped as static files in this repo.

- **Frontend:** plain HTML/CSS/JS, no framework.
- **Map + timeline:** Leaflet.js + Leaflet.timeline for the year slider. Leaflet.timeline needs a GeoJSON `FeatureCollection` with `start`/`end` properties per feature — `js/app.js`'s `photosToGeoJSON()` is the adapter that converts the flat `photos.json` array into that shape. Don't skip this step; it's the one concrete integration risk in the stack.
- **Path plotting:** click 2+ building pins → `js/app.js`'s `plotRoute()` calls the public OSRM `/route` service with all waypoints in one request (`A;B;C;...`), which returns the walking route split into one `legs[]` entry per consecutive pair, in order.
- **Stylization pipeline (`js/stylize.js`, Canvas 2D):** bilateral filter → k-means palette → edge/line overlay → **halftone (CSS, zero pixel cost) or ordered dithering (reuses the k-means palette)** → suncalc lighting tint. Halftone and dithering are alternatives, not both — pick one per style toggle.
- **Narrative:** authored in Ink, run via inkjs in the browser (`js/story.js`). See `docs/narrative-system.md` for the full design and the engineer/writer task split.
- **Data:** static `data/buildings.geojson` (Overpass building footprints), `data/photos.json` (curated dataset, see `data/photos.example.json` for the schema), `data/story.ink` / compiled `data/story.ink.json` (narrative content).
- **Hosting:** any static host works — GitHub Pages is the lowest-friction choice given prior GitHub Pages experience on the team; only reach for Vercel/Netlify if the optional serverless AI-style-toggle stretch goal gets built.
- **Growing the archive later, without building an upload system:** point contributors at Wikimedia Commons' own `Special:UploadWizard`, tagging the campus category and naming the building in the description. Re-run `scripts/fetch-commons-images.mjs` periodically to pick up new contributions — Commons provides moderation, licensing, and geo-metadata conventions for free.

**Explicitly out of scope for the hackathon build:** admin-approval panel, a hosted database, an iOS capture companion app, an Electron/native wrapper, live diffusion-model inference during judging, depth-based parallax, Gaussian splatting, full 3D scene reconstruction, procedural watercolor simulation.

## Image Sourcing

**Target: 8–12 final images, not 30–50.**

**Sources, in priority order:**

1. **Wikimedia Commons** — `Category:Williamsburg, Virginia` and related categories, many with `LCCN`/`NARA` provenance tags (safely public domain). Fetch via `scripts/fetch-commons-images.mjs` (official geosearch API, ~400m radius around campus center).
2. **W&M Digital Archive** (`digital.libraries.wm.edu`) — a live OAI-PMH endpoint, holding the *Colonial Echo* yearbook archive (1899–present) and campus scrapbooks. Deeper and more campus-specific than generic Commons results; still apply the same per-item license check before use (OAI-PMH exposes metadata, not automatic rights clearance).
3. **W&M Libraries Special Collections Research Center (SCRC)** — open to researchers, not blanket public domain. Stretch source only: email for permission on specific named items.
4. **Campus building footprints** — `scripts/fetch-buildings-overpass.mjs` (OpenStreetMap `building=*` within a hand-drawn campus bounding box) for `data/buildings.geojson`, including `start_date` where tagged.

**Per-image vetting (~5 minutes each) before it enters the dataset:** confirm the license reads `Public Domain` or `CC0` explicitly (not the weaker "no known restrictions"); record the year/decade and named building; download at least 1500px on the long edge; save the source URL and license line — this becomes the credits panel `js/app.js`'s `renderCredits()` already auto-generates from those fields.

**Geolocation:** match each photo's named building (from its description) to the nearest polygon in `buildings.geojson` by hand. Automating this match (CLIP embeddings, GeoCLIP-style geolocalizers) costs more setup time than it saves at a 8–12 photo scale.

## UI & Technique Inspiration References

**Geospatial + historical-photo precedent:**

- **Smapshot** — crowdsourced monoplotting/georeferencing of historical photos against 3D terrain.
- **PastVu** — open-source platform for gathering and geo-tagging retro photos.
- **OpenHistoricalMap** — collaborative historical map built on OpenStreetMap tooling, with a time dimension.
- **Immich's map + "choose on map" GPS correction flow** — the cleanest current reference for the photo↔map, human-in-the-loop location-assignment interaction (AGPL-3.0 — study the interaction, don't pull the code).
- **GoogleMapTimelineViewer2**-style Timeline viewers — reference implementation for time-slider/animation/clustering behavior (no visible license — study the behavior, don't copy the source).

**Comic/art stylization references:**

- **Pure CSS halftone** (leanrada.com) — the technique behind `applyHalftoneCSS()`.
- **paper.design's CMYK halftone shader** — a more "correct" WebGL alternative if there's time to integrate a shader.
- **Dithermark** — reference algorithm set (Floyd–Steinberg, Atkinson, ordered/Bayer) behind `orderedDither()`.
- **White-box Cartoonization**, **Ligne Claire Anime Diffusion** — neural/diffusion stretch options, pre-baked only, never live.
- **Blender + Freestyle NPR rendering** — the existing "3D model → Blender render" workflow many webcomic artists use; positioned as a bring-your-own-asset path (upload a Blender render as a background image like any archive photo), not something to reimplement.

**Supporting tools:** `draw-your-font` (handwriting-to-font, for character speech), **Ink/Inky/inkjs** (narrative, see `docs/narrative-system.md`), **OSRM** (walking-route plotting).
