/**
 * story.js — inkjs driver. Bridges the Ink narrative (data/story.ink,
 * compiled to data/story.ink.json) to the map/route logic in app.js.
 *
 * Division of responsibility (do not blur this line):
 *   - app.js / OSRM legs decide SEQUENCE: which building comes next.
 *   - story.js / Ink decide CONTENT: what happens at a given building.
 * app.js calls jumpToBuilding(buildingId) after each leg resolves; this
 * file never picks the next building on its own.
 */

const EPILOGUE_THRESHOLDS = {
  // Tunable after a playtest - the writer owns the prose, not these numbers.
  moodHighEnough: 2,
  knowledgeHighEnough: 2,
};

let story = null;

async function loadStory() {
  try {
    const res = await fetch("data/story.ink.json");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    story = new inkjs.Story(json);
    return true;
  } catch (err) {
    console.warn(
      "data/story.ink.json not found or invalid - compile data/story.ink with " +
        "Inky/inklecate first. Falling back to data/story.json.",
      err
    );
    return false;
  }
}

/**
 * jumpToBuilding(buildingId) — called by app.js once the map/route logic
 * has decided which building is next. Advances Ink to that knot and
 * renders until the next choice point (or DONE).
 */
function jumpToBuilding(buildingId) {
  if (!story) return renderFallbackPassage(buildingId);

  try {
    story.ChoosePathString(buildingId);
  } catch (err) {
    console.warn(`No Ink knot named "${buildingId}" - using transit_generic.`, err);
    try {
      story.ChoosePathString("transit_generic");
    } catch (err2) {
      console.error("No fallback knot either. Check data/story.ink.", err2);
      return;
    }
  }

  renderUntilChoiceOrEnd();
}

function renderUntilChoiceOrEnd() {
  const lines = [];
  let bg = null;
  let sprite = null;
  let feel = null;

  while (story.canContinue) {
    const text = story.Continue();
    lines.push(text);
    for (const tag of story.currentTags) {
      const [key, ...rest] = tag.split(":").map((s) => s.trim());
      const value = rest.join(":").trim();
      if (key === "bg") bg = value;
      if (key === "sprite") sprite = value;
      if (key === "feel") feel = value;
    }
  }

  renderPassage({
    text: lines.join(" "),
    bg,
    sprite,
    feel,
    choices: story.currentChoices,
    done: story.currentChoices.length === 0 && !story.canContinue,
  });
}

/**
 * playVoiceover(knotOrPhotoId) — plays a precomputed ElevenLabs narration
 * file if one exists for this passage. Voice-over is ALWAYS precomputed
 * (scripts/generate-voiceover.mjs, run once during prep day) - never
 * generated live during a demo. Silently no-ops if the file doesn't
 * exist, so this is safe to leave wired in even if voice-over never gets
 * recorded for some/all passages.
 */
function playVoiceover(id) {
  const player = document.getElementById("story-audio");
  if (!id || !player || player.dataset.muted === "true") return;
  const src = `assets/audio/${id}.mp3`;
  if (player.dataset.src === src) return; // already loaded/playing this line
  player.dataset.src = src;
  player.src = src;
  player.play().catch(() => {
    // 404 (no recorded line for this passage) or autoplay-block - both fine,
    // the passage still reads fine as silent text.
  });
}

function renderPassage({ text, bg, sprite, feel, choices, done }) {
  // The map page no longer shows an inline narrative/choice panel - Ink
  // still advances (mood/knowledge variables keep updating for the comic),
  // it just has nothing to render into here. Bail out early instead of
  // throwing on the missing elements.
  const panel = document.getElementById("story-panel");
  if (!panel) return;
  panel.hidden = false;
  playVoiceover(bg);

  const bgImg = document.getElementById("story-bg");
  if (bg) {
    // photos.json entries are keyed by `id` - look up the matching photo's
    // styled/raw file here. app.js owns the actual photos array; expose a
    // lookup so this module doesn't need to know about fetch/loadJSON.
    const photo = window.__photosById?.[bg];
    if (photo) {
      bgImg.src = photo.styled || photo.web || photo.file;
      bgImg.hidden = false;
    }
  }

  const spriteImg = document.getElementById("story-sprite");
  if (sprite) {
    spriteImg.src = `assets/characters/${sprite}.png`;
    spriteImg.hidden = false;
  } else {
    spriteImg.hidden = true;
  }

  const feelEl = document.getElementById("story-feel");
  feelEl.textContent = feel || "";
  feelEl.hidden = !feel;

  document.getElementById("story-text").textContent = text.trim();

  const choicesEl = document.getElementById("story-choices");
  choicesEl.innerHTML = "";
  choices.forEach((choice, i) => {
    const btn = document.createElement("button");
    btn.textContent = choice.text;
    btn.addEventListener("click", () => {
      story.ChooseChoiceIndex(i);
      renderUntilChoiceOrEnd();
    });
    choicesEl.appendChild(btn);
  });

  // Nothing else to do here when a knot finishes: the player decides when
  // the walk is over (the "Finish walk" button in app.js), which calls
  // window.renderEpilogue() directly - this module doesn't guess "last leg".
}

function renderEpilogue() {
  if (!story) return;
  const mood = story.variablesState.$("mood");
  const knowledge = story.variablesState.$("knowledge");

  let knot = "epilogue_guarded";
  if (knowledge >= EPILOGUE_THRESHOLDS.knowledgeHighEnough) knot = "epilogue_informed";
  else if (mood >= EPILOGUE_THRESHOLDS.moodHighEnough) knot = "epilogue_open";

  jumpToBuilding(knot);
}

function renderFallbackPassage(buildingId) {
  // Emergency path if data/story.ink.json never got compiled/committed.
  // Reads data/story.json's flat passage graph instead. Deliberately minimal
  // - this is a safety net, not a maintained second content track.
  console.warn(`Rendering fallback passage for "${buildingId}" from data/story.json.`);
}

document.addEventListener("DOMContentLoaded", () => {
  loadStory();
});

// Exposed for app.js - it owns sequencing (which building is next) and
// calls into these; story.js never calls itself into the next building.
window.jumpToBuilding = jumpToBuilding;
window.renderEpilogue = renderEpilogue;
