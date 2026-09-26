# Goals, Prize Categories & Judging Strategy

## Automatic consideration

- **🏆 Ampersand Award (Best AI & Imagination Hack)** — likely strongest natural fit. Pitch the imaginative/creative-generation angle (photo → comic-styled, geolocated, playable narrative) explicitly, not just the technical pipeline.
- **Best Overall / Runner-Up** — automatic, no submission action needed.

## Category challenges — submit selectively

| Category | Submit? | Why |
|---|---|---|
| Best Education Hack | **Yes** | "Teaching campus history through an interactive, geolocated, playable narrative" is a direct, honest fit for what's already built. |
| Best Linguistics Hack | No | Nothing in the build is actually linguistic analysis (handwriting fonts are typography, not language). Not worth manufacturing a fit. |
| Best Health + Nano Bio Hack | No | No fit. |
| Best Novice Hack | Only if literally true | Eligibility-gated: every team member under 2 years coding experience. Don't self-select in if it isn't accurate. |
| AI for the Common Good (Dean's / Civic Leadership) | **Yes — highest-effort submission** | See below. |

## AI for the Common Good — why this is worth real effort, not just a checkbox

Judged on: Civic Impact (30%), Innovation & Technical Achievement (25%), Human-Centered & Responsible AI (25%), Execution & Demonstration (20%).

- "Preserving and exploring civic memory" is listed as an explicit possible direction — close to a verbatim match for this project's pitch.
- "Go beyond the chatbot" calls out geospatial analysis, data visualization, multimodal AI, and human-AI collaboration — this project already has all four (OSRM/Leaflet geospatial work, map+timeline visualization, Gemini vision building-match assist, human-confirms-AI curation throughout).
- The Human-Centered & Responsible AI axis (25%) is the one most competing teams will fumble by bolting on an AI feature without designing around it. This project's existing pattern — human confirms every AI-suggested match, license/attribution shown transparently, AI features are opt-in toggles, no live inference gambled on during judging — already *is* a responsible-AI design. Say so explicitly (see the in-app "About this project" panel in `index.html`, and the Devpost draft below) rather than leaving judges to infer it.
- **Framing note:** lead with "a way for a campus community to preserve and pass down its own history, with AI augmenting curation rather than replacing human judgment" for this category's submission blurb. Same project, different emphasis than the Ampersand/tech-demo framing — both are honest, use whichever fits the audience.

## Judging rubric (every track): 5 criteria × 3 points = 15

Judges are explicitly told to score against the *stated end goal*, not just what's shipped, and functionality/engineering are judged with that end goal in mind — so say the full intended architecture out loud, and what's built vs. deliberately deferred and why.

- **Functionality (does it run smoothly in front of you)** — rehearse the actual demo path on the real venue wifi before judging, not just in code review. Confirm fallbacks (straight-line path if OSRM fails, `story.json` fallback if Ink didn't compile) actually trigger correctly if forced.
- **Engineering & Scope (technically impressive, chosen with intention)** — state the full intended architecture and which pieces are deferred and why (see `docs/build-plan.md`'s "explicitly out of scope" list) — this reframes cuts as intentional scoping, which is literally what's rewarded here.
- **Design & UX (fits the user)** — historically the least-attended-to axis in this project's planning. Don't let pipeline work crowd out an actual polish pass: make sure the halftone/dither style is visibly applied during the demo (not left as an unused toggle), the character sprite + handwriting font (if built) are actually on screen, and the map → path → story transition feels like one app, not three stitched screens.
- **Category Target (fits the track)** — applies per submission; use the framing notes above for Education vs. Civic Good vs. Ampersand. Check whether the event has an overarching theme beyond individual prize tracks and cross-check pitch language against it.
- **Innovation (novel, thought-out, surprising)** — graded on what's *said*, not just what exists. Prepare 3–4 explicit talking points and say them out loud during the demo:
  1. The map *is* the branch structure — sequence of clicked buildings changes the playthrough with zero extra authored content.
  2. Human-confirms-AI pattern used consistently (Vision background isolation, Gemini building-match) rather than a single bolted-on AI feature.
  3. Deliberate non-reinvention of existing tools — Blender/NPR renders and Dithermark-style algorithms are treated as bring-your-own-asset inputs, not rebuilt from scratch.
  4. Ink's variable-state narrative (mood/knowledge) instead of a static branching tree — procedural in a specific, honest sense (sequencing + reactive state), not runtime-generated prose pretending to be more than it is.

## Talking points checklist for the demo

- [ ] State the full intended architecture + what's deferred and why (Engineering & Scope)
- [ ] Say the 4 innovation points above out loud (Innovation)
- [ ] Reference the in-app About/Responsible-AI panel directly if presenting to Civic Good judges (Human-Centered & Responsible AI)
- [ ] Confirm the category framing matches the track being pitched to (Category Target)
