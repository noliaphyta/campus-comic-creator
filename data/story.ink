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


// ---- THREE-STOP DEMO SLICE -----------------------------------------------

=== james_blair_hall_college_of_william_and_mary_3859960606 ===
# bg: james_blair_hall_college_of_william_and_mary_3859960606
The first stop feels solid and deliberate, as if the campus has been waiting
for someone to notice the lines in its oldest walls.
{mood > 0:
    You arrive with more confidence than you expected.
- else:
    You take a moment before stepping closer.
}
* [Look for the detail that has changed]
    ~ knowledge += 1
    # feel: You notice one more layer of the place.
    -> DONE
* [Let the building set the pace]
    ~ mood += 1
    # feel: Your shoulders loosen as you keep looking.
    -> DONE

=== tucker_hall_at_the_college_of_william_and_mary_3859188517 ===
# bg: tucker_hall_at_the_college_of_william_and_mary_3859188517
At Tucker Hall, the route becomes a conversation between movement and memory.
The present-day path is busy, but the photograph leaves room for quieter
versions of the same walk.
{knowledge > 0:
    You recognize how much a familiar place can still withhold.
- else:
    You wonder what stories are hidden just outside the frame.
}
* [Ask what the photograph leaves out]
    ~ knowledge += 1
    # feel: A question can be its own kind of map.
    -> DONE
* [Follow the liveliest path through the grounds]
    ~ mood += 1
    # feel: The route feels less like a line and more like an invitation.
    -> DONE

=== taliaferro_hall_in_the_snow_at_the_college_of_william_and_mary_3502133038 ===
# bg: taliaferro_hall_in_the_snow_at_the_college_of_william_and_mary_3502133038
Snow changes the scale of Taliaferro Hall. Edges sharpen, footsteps become
evidence, and the building seems briefly separated from every season around
it.
{mood > 0:
    You are ready to let the strange weather become part of the story.
- else:
    You keep searching for the ordinary day beneath the snow.
}
* [Remember the scene as it is]
    ~ knowledge += 1
    # feel: The image becomes a small piece of evidence you can carry.
    -> DONE
* [Imagine who crossed this ground next]
    ~ mood += 1
    # feel: The past feels closer when you give it room to continue.
    -> DONE

// Photos in the larger test dataset do not yet have authored building knots.
// Keep them playable while the curated narrative grows.
=== transit_generic ===
The route carries you onward. Even without a named scene, the map has made
this place part of the walk.
* [Keep noticing]
    ~ knowledge += 1
    # feel: You make a note of what the archive does not yet explain.
    -> DONE
* [Keep moving]
    ~ mood += 1
    # feel: Momentum gives the walk its own kind of meaning.
    -> DONE


// ---- EPILOGUES -------------------------------------------------------
// Selected by js/story.js after the last leg, via simple threshold logic
// on final `mood`/`knowledge`. Thresholds live in js/story.js, tunable
// after a playtest — writer's job is the prose, not the cutoffs.

=== epilogue_guarded ===
The map folds closed, but you are not quite ready to call the walk finished.
You leave with more questions than answers, which may be the honest shape of
an archive. The buildings remain larger than the story you found in them.
-> END

=== epilogue_open ===
By the final turn, the campus feels less like a collection of destinations
and more like a place that knows how to keep a conversation going. You leave
with an urge to take the long way back and look again.
-> END

=== epilogue_informed ===
You cannot carry every date or detail with you, but you can recognize the
work of remembering: someone chose what to preserve, and someone else chose
to look. The next time you cross campus, the layers will be harder to miss.
-> END
