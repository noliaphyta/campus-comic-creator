# Devpost Submission Draft

Copy each section into the actual Devpost submission form. Bracketed notes
like `[FILL IN: ...]` mark spots that can only be answered honestly after
the hackathon actually happens — don't leave the brackets in the real
submission, but don't invent specifics to fill them either.

---

## Inspiration

Comic and webcomic backgrounds are usually built one of two ways: hand-drawn
from imagination, or modeled in 3D and rendered through something like
Blender. We wanted a third option — grounding comic art in a *real* place and
a *real* time, generated procedurally from historical archive photography
instead of drawn or modeled from scratch. William & Mary's campus was the
obvious testbed: a bounded set of named, mappable buildings with a genuinely
deep photo record (Wikimedia Commons, the campus Digital Archive, Special
Collections), which turns "photo → geolocated → dated → stylized →
narrative" into something we could actually attempt in a weekend instead of
a research project. We also wanted the AI and geospatial pieces to
*augment* human judgment — a curator confirming a building match, a player
choosing their own path — rather than replace it.

## What it does

Campus Comic Creator is an interactive map of William & Mary campus history.
A player clicks two or more building pins to plot a walking path between
them; the route is drawn using real OpenStreetMap pedestrian-routing data.
At each stop, an archive photo of that building is procedurally styled into
a comic-ready background live in the browser — flattened, palette-reduced,
outlined, and finished with a halftone or dithered ink texture — while a
short branching scene plays out with the player's character, using
[FILL IN: character name] moving between stops. Choices shift the
character's mood and how much they've learned along the way, which shapes
which of three possible endings they reach. A year slider filters which
photos are available at each stop, so the same walk can look different
depending on when you take it.

## How we built it

- **Map & routing:** Leaflet.js for the interactive map, OSRM's public
  pedestrian-routing API for multi-waypoint path plotting (one request
  handles the whole A→B→C sequence), and OpenStreetMap building footprints
  pulled via the Overpass API.
- **Data sourcing:** a one-time script hits Wikimedia Commons' official
  geosearch API directly for openly-licensed historical campus photos,
  hand-curated down to a small, license-verified set rather than scraped in
  bulk.
- **Procedural stylization:** a hand-written Canvas 2D pipeline — bilateral
  filtering, k-means palette extraction, edge/line overlay, and a choice of
  CSS-based halftone or palette-aware ordered dithering — all running
  client-side, live, during the demo.
- **Narrative:** written in Ink (Inkle's branching-narrative scripting
  language) and run in-browser via inkjs. The story doesn't branch on
  dialogue trees — it branches on *geography*: the order a player visits
  buildings in is itself the branch, with a small set of persistent
  variables (mood, knowledge) driving reactive flavor text and one of three
  epilogues, rather than a combinatorial passage tree.
- **AI, used deliberately and kept optional:** [FILL IN: which of Gemini /
  ElevenLabs actually made it in] — Gemini for vision-based building-match
  suggestions during photo curation (a human confirms every suggestion
  before it's used), and/or ElevenLabs for precomputed character
  voice-over, generated once ahead of time rather than called live during
  the demo.
- **Hosting:** a single static site, no backend or database — everything is
  precomputed once and shipped as static files.

## Challenges we ran into

- Matching Leaflet.timeline's expected GeoJSON `FeatureCollection` shape
  against our own flat photo-metadata format needed a small adapter step we
  almost missed until we caught it during planning.
- Licensing diligence took longer per photo than expected — confirming a
  license genuinely reads "Public Domain" or "CC0," not just "no known
  restrictions," and tracking down a real building match for each photo,
  was the single most time-consuming manual step in the whole project.
- [FILL IN: any real OSRM rate-limit / demo-day network issues encountered]
- [FILL IN: any Ink-compile or inkjs-integration snag actually hit]
- Deciding what *not* to build was its own challenge — early planning
  considered Gaussian splatting, full neural cartoonization, and live
  AI-generated narrative, all of which we deliberately scoped out in favor
  of a smaller, reliable, always-works pipeline.

## Accomplishments that we're proud of

- A genuinely procedural stylization pipeline that runs live, client-side,
  with no server and no live AI inference required for the core demo.
- A narrative structure where the map itself is the branching mechanism —
  two players taking the same buildings in a different order get a
  structurally different experience with zero extra authored content.
- Keeping every AI-assisted step human-confirmed rather than
  fully-automated, by design, from the first planning pass onward — not
  bolted on afterward to satisfy a prize category.
- [FILL IN: final photo count curated, any specific building/story moment
  the team is proud of]

## What we learned

- How much of "using archive data responsibly" is licensing and
  attribution bookkeeping, not code — and how to make that bookkeeping pay
  for itself by feeding it straight into an auto-generated credits panel.
- Ink's variable-state model is a much better fit for "reactive but
  shallow" branching narrative than a traditional passage tree, especially
  once the *sequence* of content is decided by something else (the map)
  rather than the script itself.
- OpenStreetMap's ecosystem (Overpass for building data, OSRM for routing)
  already solves most of the "campus has discrete, mappable locations"
  problem — worth checking what already exists before building custom
  geospatial tooling.
- [FILL IN: anything the team learned about Gemini/ElevenLabs integration
  specifically, once actually wired in]

## What's next for Campus Comic Creator

- A public submission flow (currently: point contributors at Wikimedia
  Commons' own upload tool rather than building our own moderation system)
  with a real admin-approval queue.
- Depth-based parallax backgrounds (monocular depth estimation, layered
  planes) as a cheaper alternative to full 3D reconstruction.
- An optional live AI narrative-generation toggle (Gemini), gated behind
  the existing hand-authored Ink script as the always-safe default path.
- Extending past William & Mary to any campus or town with an open photo
  archive and mappable building data — nothing in the pipeline is
  W&M-specific except the curated dataset itself.

---

## Built With

`javascript` `html5` `css3` `leaflet` `leaflet-timeline` `openstreetmap`
`overpass-api` `osrm` `canvas-api` `ink` `inkjs` `wikimedia-commons-api`
`google-gemini-api` `elevenlabs` `node-js` `github-pages`

(Trim `google-gemini-api` and/or `elevenlabs` from this list if one of them
didn't end up integrated — Devpost's tag list should match what's actually
in the submitted build, not the full stretch-goal scope.)
