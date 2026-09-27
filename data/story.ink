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
The first stop feels solid and deliberate, like a place someone once decided
was worth keeping. Nothing about that survival was automatic - a building
this old stands because generations of people chose, over and over, to
maintain it rather than let it go.
{mood > 0:
    You arrive already thinking about who gets to make that choice.
- else:
    You take a moment to notice it was a choice at all.
}
* [Ask what was preserved here, and by whom]
    ~ knowledge += 1
    # feel: You notice the quiet work of stewardship behind the walls.
    -> DONE
* [Let the weight of that history set the pace]
    ~ mood += 1
    # feel: Your shoulders loosen as the place settles into you.
    -> DONE

=== tucker_hall_at_the_college_of_william_and_mary_3859188517 ===
# bg: tucker_hall_at_the_college_of_william_and_mary_3859188517
At Tucker Hall, the route becomes a conversation between movement and memory.
The present-day path is busy with people who never asked to be part of an
archive, but the photograph leaves room for the quieter version of this walk
someone else once took.
{knowledge > 0:
    You recognize how much a shared place can still withhold from the people
    who pass through it every day.
- else:
    You wonder what this community knows about its own ground that never made
    it into a caption.
}
* [Ask what the photograph leaves out]
    ~ knowledge += 1
    # feel: A question can be its own kind of civic record.
    -> DONE
* [Follow the liveliest path through the grounds]
    ~ mood += 1
    # feel: The route feels less like a line and more like a shared invitation.
    -> DONE

=== taliaferro_hall_in_the_snow_at_the_college_of_william_and_mary_3502133038 ===
# bg: taliaferro_hall_in_the_snow_at_the_college_of_william_and_mary_3502133038
Snow changes the scale of Taliaferro Hall. Edges sharpen, footsteps become
evidence of who was here, and the building seems briefly separated from
every season - and every steward - that came before this one.
{mood > 0:
    You are ready to let this moment take its place alongside the ones that
    came before it.
- else:
    You keep looking for the ordinary day someone thought was worth saving
    beneath the snow.
}
* [Remember the scene as evidence worth keeping]
    ~ knowledge += 1
    # feel: The image becomes a small piece of the record you now carry.
    -> DONE
* [Imagine who will be trusted with this ground next]
    ~ mood += 1
    # feel: The past feels closer when you plan to pass it on.
    -> DONE

// Photos in the larger test dataset do not yet have authored building knots.
// Keep them playable while the curated narrative grows.
=== transit_generic ===
The route carries you onward, past a place with no named scene yet - not
because it doesn't matter, but because no one has finished the work of
remembering it. The map has made it part of the walk anyway; the archive
is still catching up.
* [Notice what hasn't been recorded here yet]
    ~ knowledge += 1
    # feel: You make a note of what this community hasn't archived for itself.
    -> DONE
* [Keep moving, and trust it will be someone's turn to fill this in]
    ~ mood += 1
    # feel: Momentum gives the walk its own kind of civic patience.
    -> DONE


// ---- EPILOGUES -------------------------------------------------------
// Selected by js/story.js after the last leg, via simple threshold logic
// on final `mood`/`knowledge`. Thresholds live in js/story.js, tunable
// after a playtest — writer's job is the prose, not the cutoffs.

=== epilogue_guarded ===
The map folds closed, but you are not quite ready to call the walk finished.
You leave with more questions than answers about who this ground has served
and who it hasn't, which may be the honest shape of a civic archive. The
buildings remain larger than the story you found in them - and larger than
any one walk could account for.
-> END

=== epilogue_open ===
By the final turn, the campus feels less like a collection of destinations
and more like a community still in the middle of deciding what it wants to
remember. You leave with an urge to take the long way back, look again, and
maybe say something to the next person you see about what you noticed.
-> END

=== epilogue_informed ===
You cannot carry every date or detail with you, but you can recognize the
civic work underneath the archive: someone chose what to preserve, someone
else chose to look, and now you have chosen to pass it on. The next time you
cross this campus, the layers - and the people who kept them - will be
harder to miss.
-> END
