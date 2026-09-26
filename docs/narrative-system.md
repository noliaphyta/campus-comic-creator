# Narrative System — Engineer / Writer Split

## Design summary

The branching comes from **geography, not prose**. The player's map route (which buildings, in what order — see `plotRoute()` in `js/app.js`) is the real branch; the text at each stop is comparatively shallow and reactive rather than a combinatorial tree. State is carried as persistent Ink variables (`mood`, `knowledge`) rather than branch-specific unique passages. Content is authored in **Ink** (`data/story.ink`, one knot per building), compiled, and run through **inkjs** in the browser (`js/story.js`). Ink's tags (`# bg:`, `# sprite:`, `# feel:`) are the bridge between story text and the visual pipeline — the script drives which photo/sprite shows, not the other way around.

**Division of responsibility — keep this separation clean:**
- `js/app.js` (map/OSRM legs) decides **sequence**: which building is next.
- `data/story.ink` + `js/story.js` decide **content**: what happens at a place.

"Procedural" means the map-driven sequencing plus state-reactive flavor text — not runtime-generated prose. All narrative text is hand-written; only which text plays, and which photo/sprite accompanies it, is computed.

## Track 1 — Engineer (already scaffolded in this repo)

- [x] `js/story.js` — inkjs driver: loads `data/story.ink.json`, `jumpToBuilding()`, tag parsing (`bg`/`sprite`/`feel`), choice rendering, `renderEpilogue()` threshold logic.
- [x] `js/app.js` — `plotRoute()` (OSRM multi-waypoint), `onPhotoSelected()` calling into `window.jumpToBuilding()`, `renderCredits()`.
- [x] `data/story.ink` — tag schema documented, `waiting_room` entry knot, epilogue knot stubs.
- [x] `js/app.js` wires `runStylizeAndStory()` to live-stylize the selected photo before invoking `jumpToBuilding()`. The player explicitly ends the open-ended walk with `Finish walk`, which calls `renderEpilogue()`.
- [x] `data/story.ink` contains the first three building knots, a `transit_generic` test-dataset fallback, and three epilogues; the compiled runtime is committed as `data/story.ink.json`.
- [ ] QA: confirm every knot ends cleanly (`-> DONE` / `-> END`, no dead ends) and that `transit_generic` fallback actually exists and is reachable before demo day.

## Track 2 — Writer (fill in `data/story.ink`)

### Content budget
- 5–6 buildings, matching the curated `data/photos.json` set exactly (one knot each, named to match each photo's `id`).
- 2 choices per building, always converging to `-> DONE` — no dead ends.
- One flavor variation per building, driven by current `mood`/`knowledge` (a single reactive sentence, not a rewritten passage) — e.g. `{mood > 0: ...|else: ...}`.
- 150–250 words per building node.
- 3 epilogue variants (`epilogue_guarded` / `epilogue_open` / `epilogue_informed`), 100–150 words each.
- Total target: ~1,200–1,800 words.

### Choice-writing rules
1. Never let a choice look bigger or smaller than it is — a flavor-only choice should read as optional color, not a plot fork.
2. Always give a visible acknowledgment when state changes, via a `# feel:` tag line (e.g. "you seem a little more at ease") — this is what makes the invisible variable tracking feel real to the player.
3. Write reactive text as a conditional on the current variable, not as a separate passage.

### Tag schema (must match `js/story.js` exactly — don't invent new tags without telling the engineer)
- `# bg: <photo id>` — matches the `id` field in `data/photos.json`.
- `# sprite: <char>_<pose>_<emotion>` — matches a file in `assets/characters/`.
- `# feel: <short text>` — optional state-change acknowledgment.

### What NOT to do
- No dead-end choices or non-reconverging branches.
- No full alternate scenes per mood state — one reactive sentence is the budget.
- Don't hand-author which building follows which — that's the player's map route; every knot should read fine regardless of what came immediately before it.
