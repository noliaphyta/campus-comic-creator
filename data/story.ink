// story.ink — WRITER'S FILE. See docs/narrative-system.md Track 2 for the
// full brief (content budget, choice-writing rules, tag schema).
//
// One knot per building, named to match the `id` field in data/photos.json.
// Every knot must end by returning control to the app (-> DONE), never by
// -> jumping to another building knot directly — the app decides what plays
// next based on the player's map route (OSRM legs), not this script.
//
// Tag schema (read by js/story.js — don't invent new tags without updating
// both files):
//   # bg: <photo id>              which photo/background to display
//   # sprite: <char>_<pose>_<emotion>   which character asset to composite
//   # feel: <short text>          state-change acknowledgment line (optional)
//
// Compile this file with Inky (https://github.com/inkle/inky) or the
// inklecate CLI to data/story.ink.json before it's usable by inkjs at
// runtime. The compiled JSON is gitignored until you're ready to commit a
// real build (see .gitignore) — commit the compiled JSON once the content
// is real, so the deployed site doesn't need a compile step.

VAR mood = 0
VAR knowledge = 0

-> waiting_room

// The app calls story.ChoosePathString("<building_id>") after each OSRM leg
// resolves. This knot is never reached in normal play; it exists so the
// story has a valid entry point before the app makes its first jump.
=== waiting_room ===
-> DONE


// ---- EXAMPLE BUILDING KNOT (copy this shape per building) ----------------
// Delete this comment block once real knots replace it.
//
// === wren_building ===
// # bg: wren_building
// # sprite: mara_walk_neutral
// {mood > 0: You feel steadier here than you expected.|You keep your guard up.}
// The {photo_year} light falls the same way it did when this was drawn.
// * [Ask about the fire]
//     ~ knowledge += 1
//     # feel: (you learn something you didn't expect to)
//     -> wren_building_fire
// * [Keep walking]
//     -> DONE
//
// === wren_building_fire ===
// The Wren Building burned twice, in 1705 and 1859, and was rebuilt after both.
// -> DONE
// ---------------------------------------------------------------------------


// ---- EPILOGUES -------------------------------------------------------
// Selected by js/story.js after the last leg, via simple threshold logic
// on final `mood`/`knowledge`. Thresholds live in js/story.js, tunable
// after a playtest — writer's job is the prose, not the cutoffs.

=== epilogue_guarded ===
// WRITER: 100-150 words. Low mood / low knowledge ending.
-> END

=== epilogue_open ===
// WRITER: 100-150 words. High mood ending.
-> END

=== epilogue_informed ===
// WRITER: 100-150 words. High knowledge ending.
-> END
