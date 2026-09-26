# Campus Comic Creator

A geospatial map + timeline of William & Mary campus photos, procedurally
stylized into comic-style backgrounds, driving a short branching narrative
walking a character between the buildings the player picks.

Full plans: **[docs/build-plan.md](docs/build-plan.md)** (motivation, demo
goal, architecture, image sourcing, UI references),
**[docs/narrative-system.md](docs/narrative-system.md)** (the Ink narrative
system, split into engineer tasks and writer tasks), and
**[docs/goals-and-judging.md](docs/goals-and-judging.md)** (which prize
categories to target and why, plus a rubric-by-rubric strategy checklist).
**[docs/devpost-draft.md](docs/devpost-draft.md)** has a filled-in draft of
the actual Devpost submission form, ready to copy in and finish after the
event.

## Repo layout

```
index.html                  entry point: map, path controls, story panel
css/style.css
js/app.js                   map / OSRM path plotting / timeline / credits
js/stylize.js                the art pipeline (halftone + dither modules stubbed)
js/story.js                  inkjs driver - bridges the Ink script to the map
data/buildings.geojson       Overpass building footprints (prep day)
data/paths.geojson           Overpass dedicated footpaths (prep day) - see
                              "Why walking routes can look like driving
                              routes" below
data/photos.json             curated photo dataset (prep day, hand-authored)
                              - see data/photos.example.json for the schema
data/story.ink                narrative source (writer's file, see docs/narrative-system.md)
data/story.ink.json           compiled Ink output (commit once content is real)
data/story.json               emergency fallback only - not a parallel content track
assets/photos/raw/            source photos, license-checked, 1500px+ long edge
assets/photos/styled/         precomputed stylized output per photo (safety net)
assets/characters/            character pose/emotion art (provided separately)
scripts/fetch-commons-images.mjs
                              ONE-TIME prep-day script - Wikimedia Commons geosearch
scripts/fetch-buildings-overpass.mjs
                              ONE-TIME prep-day script - OSM building footprints
```

## One-time data fetches (prep day, not run from the deployed site)

```
node scripts/fetch-commons-images.mjs --lat 37.2712 --lon -76.7112 --radius 400 --out ./data
node scripts/fetch-buildings-overpass.mjs --south 37.266 --west -76.716 --north 37.276 --east -76.706
node scripts/fetch-footpaths-overpass.mjs --south 37.266 --west -76.716 --north 37.276 --east -76.706
```

The Commons script writes `data/commons-geosearch-raw.json` and
`data/photos.scaffold.json` (both gitignored — working files). Hand-curate
the scaffold down to 8–12 images (license check, building match, resolution
check — see docs/build-plan.md's "Image Sourcing" section) and write the
result into `data/photos.json` yourself, following `data/photos.example.json`'s
schema. The buildings script writes `data/buildings.geojson` directly, and
the footpaths script writes `data/paths.geojson` directly - use the same
bbox for both.

### Why walking routes can look like driving routes

The app uses profile-specific OSRM services: `routed-foot`, `routed-bike`, and
`routed-car` on `routing.openstreetmap.de`. The generic public OSRM endpoint
accepted `foot` and `bike` in the URL but returned the same campus route for
all three profiles, so selecting the profile-specific service is important.

Even with the correct service, a foot route can still follow roads when there
is no dedicated pedestrian way in the routing graph. That is usually an OSM
data-coverage gap on campus interiors: college quads, plaza walkways, and
building-to-building shortcuts may be missing even when surrounding streets
are well mapped.

Run `scripts/fetch-footpaths-overpass.mjs` to pull whatever dedicated
footway/path/pedestrian/steps ways OSM already has in your bbox into
`data/paths.geojson`; `js/app.js` renders them as a thin blue dashed layer.
If that layer is empty (or sparse) near the buildings you're routing
between, that's your answer - the fix is mapping the real paths in OSM (or
sourcing them from campus GIS), not changing routing code. The app also
now shows a live status line next to the "Path type" dropdown (distance,
time, and a note when a "foot" route has no nearby mapped footpath), so this
is visible during a demo instead of only in the browser console.

## Narrative content

Write `data/story.ink` (see `docs/narrative-system.md` for the brief and
tag schema), then compile it to `data/story.ink.json` with
[Inky](https://github.com/inkle/inky) or the `inklecate` CLI before it's
usable by `js/story.js`. Commit the compiled JSON once the content is real.

## Optional AI integrations (Gemini, ElevenLabs)

Both are scaffolded and **off by default** — the core demo never depends on
either. Both scripts are prep-day/curation tools, never called from the
deployed site or live during judging.

```
cp .env.example .env
# paste in the event-provided API key(s)
node --env-file=.env scripts/suggest-building-match.mjs   # Gemini: building-match suggestions
node --env-file=.env scripts/generate-voiceover.mjs        # ElevenLabs: precomputed narration
```

- **Gemini** (`scripts/suggest-building-match.mjs`) — suggests which campus
  building an archive photo shows, using vision understanding, during photo
  curation. Writes a `building_suggestion` field to
  `data/photos.scaffold.json`; a human still confirms before it's copied
  into the real `data/photos.json`. Never auto-writes the real dataset.
- **ElevenLabs** (`scripts/generate-voiceover.mjs`) — generates narration
  audio per Ink knot once the story content is final, written to
  `assets/audio/<knot_id>.mp3`. `js/story.js` already looks for files at
  that path and plays them automatically if present, with a mute toggle in
  the UI — no other wiring needed once the audio files exist.

`.env` is gitignored — never commit a real API key. If a key isn't
available, both scripts fail loudly with a clear message rather than
silently degrading; the app itself works fully without either.

## Growing the archive later

No upload form on this site. Point contributors at Wikimedia Commons' own
`Special:UploadWizard`, ask them to tag `Category:Williamsburg, Virginia`
and name the building in the description, then re-run
`scripts/fetch-commons-images.mjs` whenever you want to refresh the dataset.

## Hosting

GitHub Pages is the default choice here — no backend to outgrow, and it's
the lowest-friction option given prior GitHub Pages experience on the team.
Move to Vercel/Netlify only if the optional serverless AI-style-toggle
stretch goal gets built.

## Local dev

No build step required. Serve through a local server (not `file://`, or
`fetch()` calls to `/data/*.json` will be blocked by the browser):

```
python3 -m http.server 8080
# or
npx serve .
```

### Testing with more photos

The normal app uses the curated `data/photos.json` dataset. To exercise the
larger, 140-entry Commons candidate pool, open:

```
http://localhost:8080/?dataset=test
```

The test mode reads `data/photos.scaffold.json` directly, so it does not
duplicate that generated fixture. Its entries are intentionally uncurated:
many do not have confirmed building matches, and licenses include CC BY,
CC BY-SA, CC0, and Public Domain. Use this mode for testing markers,
clustering, filmstrip pagination, year filtering, and loading fallbacks only;
review and copy individual entries into `data/photos.json` before treating
them as production content.

The scaffold points at Wikimedia's remote image URLs. Those are suitable for
map thumbnails, but live Canvas stylization can be blocked by cross-origin
image restrictions; when testing stylization, download selected images into
`assets/photos/raw/` and update their `file` fields to local paths.
