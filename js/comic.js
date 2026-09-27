/**
 * comic.js — standalone driver for comic.html.
 *
 * Deliberately separate from js/app.js / js/story.js: the map page owns
 * PATH SELECTION (click pins -> selectedWaypoints -> "Generate Comic"
 * button -> stashes the path's photos into localStorage("ccc_comic_path")
 * and navigates here - see goToComicCreator() in js/app.js). This page owns
 * turning that path into a comic strip. Neither page reaches into the
 * other's internals; localStorage is the only handoff.
 *
 * Autogenerate pipeline per path node, in order:
 *   1. crop the photo to the chosen aspect ratio (cropToAspect)
 *   2. run it through js/stylize.js's filter pipeline (stylizePhoto)
 *   3. lay a character bounding-box placeholder over it (real art later)
 *   4. add a textbox whose caption types in character-by-character
 *      (typewriter), sourced from data/story.ink.json when possible so the
 *      comic uses the same hand-written narrative as the live map/story
 *      panel - not a second, drifting content track (see
 *      docs/narrative-system.md).
 *
 * "Manually select styles & story" is left as a disabled radio for now -
 * autogenerate is the first target (see request.txt).
 */

// buildingLabel() and attributionLine() now live in js/shared.js (loaded
// before this file).

// renderedPanels: one entry per panel actually drawn by the most recent
// renderPanels() call, keeping the live canvas around (not just the data
// URL baked into the <img>) so the save/export functions below have real
// pixels to zip up. Reset at the top of renderPanels(). lastRenderCtx is
// the renderPanels() call's own arguments, kept for "Copy shareable link"
// (buildRecipe needs the exact photos/aspect/mode/perPanel that produced
// what's on screen right now).
let renderedPanels = [];
let lastRenderCtx = null;

// Character bounding-box placeholder position, as fractions of the panel.
// Read by BOTH renderCharacterPlaceholder() (DOM, percentages) and
// characterBboxRect() (canvas, pixels) so the two can't drift apart - swap
// these numbers once and both the live page and the exported PNG follow.
const CHAR_BBOX = { width: 0.26, height: 0.55, bottom: 0.14, left: 0.08, right: 0.08, center: 0.37 };

function characterBboxRect(side, canvasWidth, canvasHeight) {
  const w = canvasWidth * CHAR_BBOX.width;
  const h = canvasHeight * CHAR_BBOX.height;
  const y = canvasHeight * (1 - CHAR_BBOX.bottom) - h;
  let x;
  if (side === "right") x = canvasWidth * (1 - CHAR_BBOX.right) - w;
  else if (side === "center") x = canvasWidth * CHAR_BBOX.center;
  else x = canvasWidth * CHAR_BBOX.left;
  return { x, y, w, h };
}

/**
 * bakeOverlaysOntoCanvas(canvas, side) — draws the character bounding-box
 * rectangle (same math as the DOM version) directly onto the panel's
 * pixels, for the "Download finished comic" export. No caption/feel text
 * baked in - those stay a page-only overlay (see comicpublishplan.txt
 * step 3's revision). Idempotent: guarded so re-exporting the same canvas
 * doesn't double-stroke the rectangle.
 */
function bakeOverlaysOntoCanvas(canvas, side) {
  if (canvas.dataset.baked === "true") return;
  const ctx = canvas.getContext("2d");
  const { x, y, w, h } = characterBboxRect(side, canvas.width, canvas.height);
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = Math.max(2, canvas.width * 0.004);
  ctx.setLineDash([canvas.width * 0.012, canvas.width * 0.012]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
  canvas.dataset.baked = "true";
}

function wireDarkMode() {
  const btn = document.getElementById("dark-mode-toggle");
  if (!btn) return;
  const stored = localStorage.getItem("ccc_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(stored ? stored === "dark" : prefersDark);

  btn.addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    applyTheme(!isDark);
    localStorage.setItem("ccc_theme", !isDark ? "dark" : "light");
  });

  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    btn.textContent = dark ? "☀️" : "🌙";
  }
}

/**
 * renderPathCredits(photos, target) — same copy-pastable attribution block
 * as the map page (js/app.js's renderCredits()), but scoped to ONLY the
 * photos in this path, in path order, since that's the set this specific
 * comic actually uses. `target` defaults to the page's #credits-panel
 * (comic.html's always-visible credits strip); presentVisualNovel() passes
 * its own end-screen container instead so the viewer can show credits only
 * once the story is finished rather than up front.
 */
function renderPathCredits(photos, target) {
  const el = target || document.getElementById("credits-panel");
  if (!el) return;
  if (!photos.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const items = photos
    .map((p) => {
      const creator = p.creator ? ` — photo by ${p.creator}` : "";
      return (
        `<li>${buildingLabel(p)}, ${p.year ?? "?"}${creator} — ${p.license ?? "license unknown"} — ` +
        `<a href="${p.source ?? "#"}" target="_blank" rel="noopener">Wikimedia Commons file page</a></li>`
      );
    })
    .join("");
  const plainText = photos.map(attributionLine).join("\n");

  el.innerHTML =
    `<strong>Credits for this comic</strong><ul>${items}</ul>` +
    `<div class="attribution-copy-block">` +
    `<div class="attribution-copy-header"><span>Copy-pastable attribution</span>` +
    `<button type="button" id="copy-credits-btn">Copy</button></div>` +
    `<pre id="attribution-plaintext" tabindex="0"></pre>` +
    `</div>`;
  el.querySelector("#attribution-plaintext").textContent = plainText;

  const copyBtn = el.querySelector("#copy-credits-btn");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      copyBtn.textContent = "Copied!";
    } catch (err) {
      const range = document.createRange();
      range.selectNodeContents(el.querySelector("#attribution-plaintext"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copyBtn.textContent = "Select-all applied";
      console.warn("navigator.clipboard.writeText failed - selected the text instead.", err);
    }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // Commons images are served with CORS headers on
    img.onload = () => resolve(img); // -> upload.wikimedia.org; needed so canvas isn't tainted.
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * cropToAspect(img, ratioW, ratioH) -> canvas
 * Centers a crop of the source image to the target aspect ratio (cover
 * behavior, like CSS object-fit: cover) rather than squashing it, so
 * buildings don't come out stretched.
 */
function cropToAspect(img, ratioW, ratioH) {
  const targetRatio = ratioW / ratioH;
  const srcRatio = img.width / img.height;

  let sx, sy, sw, sh;
  if (srcRatio > targetRatio) {
    sh = img.height;
    sw = sh * targetRatio;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / targetRatio;
    sx = 0;
    sy = (img.height - sh) / 2;
  }

  const canvas = document.createElement("canvas");
  const OUT_WIDTH = 1000; // fixed output width keeps every panel the same size regardless of source photo resolution
  canvas.width = OUT_WIDTH;
  canvas.height = Math.round(OUT_WIDTH / targetRatio);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function parseAspect(value) {
  const [w, h] = value.split(":").map(Number);
  return { w, h, css: `${w} / ${h}` };
}

/**
 * medianColor(canvas) -> "rgb(r, g, b)"
 * Samples the given canvas (or image) down to a small grid and takes the
 * per-channel MEDIAN (not mean/average) across those samples, so one
 * blown-out sky or a dark doorway doesn't drag an otherwise-midtone photo's
 * backdrop color to an extreme the way an average would. Used to color the
 * letterbox/pillarbox area behind a contained (not cropped) VN panel image
 * - see buildVNPanel() below.
 */
function medianColor(source) {
  const SAMPLE = 24; // small grid is plenty for a background tint and keeps this cheap
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, SAMPLE, SAMPLE);
  let data;
  try {
    data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch (err) {
    // Can throw on a tainted canvas if a source image's CORS headers were
    // missing (shouldn't happen for Commons uploads - see loadImage() - but
    // fall back to a neutral dark tone rather than let the whole panel fail).
    console.warn("medianColor: canvas read blocked, falling back to a neutral background.", err);
    return "rgb(20, 20, 20)";
  }
  const r = [], g = [], b = [];
  for (let i = 0; i < data.length; i += 4) {
    r.push(data[i]);
    g.push(data[i + 1]);
    b.push(data[i + 2]);
  }
  const mid = (arr) => {
    arr.sort((a, c) => a - c);
    return arr[Math.floor(arr.length / 2)];
  };
  return `rgb(${mid(r)}, ${mid(g)}, ${mid(b)})`;
}

/**
 * renderCharacterPlaceholder(panelEl, aspect) — a plain rectangle standing
 * in for the character sprite's bounding box (see js/story.js /
 * assets/characters/ for the real art this will become). Sized/positioned
 * as a fraction of the panel so it scales with any aspect ratio; swap this
 * function's box math out once real character art with known proportions
 * exists, nothing else in the pipeline needs to change.
 */
function renderCharacterPlaceholder(panelEl, side = "left") {
  const box = document.createElement("div");
  box.className = "character-bbox";
  box.style.width = `${CHAR_BBOX.width * 100}%`;
  box.style.height = `${CHAR_BBOX.height * 100}%`;
  if (side === "right") box.style.right = `${CHAR_BBOX.right * 100}%`;
  else if (side === "center") box.style.left = `${CHAR_BBOX.center * 100}%`;
  else box.style.left = `${CHAR_BBOX.left * 100}%`;
  box.textContent = "Character";
  panelEl.appendChild(box);
}

/**
 * typewriter(el, text) — reveals `text` into `el` one character at a time.
 * Plain JS/DOM, no library - this is what "text animation appear character
 * by character" means here. Starts only once the panel scrolls into view
 * (see the IntersectionObserver in renderPanels()) so panels further down
 * the strip don't all finish typing before the player has scrolled to them.
 */
function typewriter(el, text, speedMs = 18) {
  el.textContent = "";
  const cursor = document.createElement("span");
  cursor.className = "caption-cursor";
  cursor.textContent = "▍";
  let i = 0;
  const timer = setInterval(() => {
    i++;
    el.textContent = text.slice(0, i);
    el.appendChild(cursor);
    if (i >= text.length) {
      clearInterval(timer);
      cursor.remove();
    }
  }, speedMs);
}

/**
 * captionsForPath(photos) -> Promise<string[]>
 * Pulls each path node's actual Ink passage text (data/story.ink.json),
 * auto-picking the FIRST choice at any choice point (this is the
 * "autogenerate" path - no player in the loop) so the comic uses the same
 * hand-written narrative as the live map/story panel instead of a second
 * drifting content track. Falls back to a plain building/year caption per
 * node if the compiled Ink file isn't there yet or a knot is missing -
 * mirrors js/story.js's own transit_generic/fallback behavior.
 */
async function captionsForPath(photos) {
  let storyJson = null;
  try {
    const res = await fetch("data/story.ink.json");
    if (res.ok) storyJson = await res.json();
  } catch (err) {
    console.warn("data/story.ink.json not available - using plain captions.", err);
  }

  return photos.map((photo) => {
    const fallback = `${buildingLabel(photo)}${photo.year ? ` — ${photo.year}` : ""}`;
    if (!storyJson) return { text: fallback, feel: null };

    try {
      const story = new inkjs.Story(storyJson); // fresh instance per node - no shared mood/knowledge bleed between panels
      try {
        story.ChoosePathString(photo.id);
      } catch (err) {
        story.ChoosePathString("transit_generic");
      }
      const lines = [];
      let feel = null;
      while (story.canContinue) {
        lines.push(story.Continue());
        for (const tag of story.currentTags) {
          const [key, ...rest] = tag.split(":").map((s) => s.trim());
          if (key === "feel") feel = rest.join(":").trim();
        }
      }
      if (story.currentChoices.length) {
        story.ChooseChoiceIndex(0); // autogenerate: always take the first choice
        while (story.canContinue) {
          lines.push(story.Continue());
          for (const tag of story.currentTags) {
            const [key, ...rest] = tag.split(":").map((s) => s.trim());
            if (key === "feel") feel = rest.join(":").trim();
          }
        }
      }
      const text = lines.join(" ").trim();
      return { text: text || fallback, feel };
    } catch (err) {
      console.warn(`Ink knot lookup failed for "${photo.id}" - using plain caption.`, err);
      return { text: fallback, feel: null };
    }
  });
}

/**
 * buildPanel(photo, i, total, aspect, settings) -> Promise<{panelEl, caption, canvas}>
 * Does the actual generation work for one panel - crop, stylize, character
 * bbox placeholder, textbox - shared by both the strip view (comic.html)
 * and the one-at-a-time visual-novel view (comic-view.html). Presentation
 * (what's visible/how you advance) is layered on by the two callers below,
 * not by this function.
 */
async function buildPanel(photo, i, total, aspect, settings) {
  const panel = document.createElement("div");
  panel.className = "comic-panel";
  panel.style.aspectRatio = aspect.css;

  const idx = document.createElement("span");
  idx.className = "panel-index";
  idx.textContent = `${i + 1} / ${total}`;
  panel.appendChild(idx);

  const img = document.createElement("img");
  img.className = "panel-bg";
  img.alt = buildingLabel(photo);

  let panelCanvas = null; // set below on success; stays null if load/crop/filter failed
  try {
    const srcImg = await loadImage(photo.web || photo.file);
    const cropped = cropToAspect(srcImg, aspect.w, aspect.h);
    if (settings.filterStyle === "none" || typeof stylizePhoto !== "function") {
      panelCanvas = cropped;
    } else {
      const { canvas, ditherStyle } = stylizePhoto(cropped, { year: photo.year, lat: photo.lat, lon: photo.lon }, { ditherStyle: settings.filterStyle });
      panelCanvas = canvas;
      // stylizePhoto() falls back to "css-fallback" uniformly when WebGL
      // isn't available this session (see js/stylize.js changelog) - flag
      // it visibly rather than silently showing a plain photo next to
      // fully-stylized panels, which would read as a bug rather than a
      // deliberate reduced-fidelity mode.
      if (ditherStyle === "css-fallback") {
        img.classList.add("style-halftone");
        panel.dataset.stylizeFallback = "true";
      }
    }
    img.src = panelCanvas.toDataURL("image/png");
  } catch (err) {
    console.warn(`Could not load/crop/filter "${photo.id}" - falling back to the unfiltered image.`, err);
    img.src = photo.styled || photo.web || photo.file;
  }
  panel.appendChild(img);

  renderCharacterPlaceholder(panel, settings.charSide);

  const textbox = document.createElement("div");
  textbox.className = "comic-textbox";
  const caption = document.createElement("span");
  caption.className = "caption-text";
  textbox.appendChild(caption);
  if (settings.feel) {
    const feelEl = document.createElement("span");
    feelEl.className = "feel-line";
    feelEl.textContent = settings.feel;
    textbox.appendChild(feelEl);
  }
  panel.appendChild(textbox);

  return { panel, caption, canvas: panelCanvas };
}

function resolvedSettings(photos, perPanel, i) {
  // Shared links and older recipes may omit a panel entry. Keep rendering
  // usable with safe defaults instead of crashing on settings.filterStyle.
  return {
    filterStyle: "halftone",
    captionText: `${buildingLabel(photos[i])}${photos[i].year ? ` — ${photos[i].year}` : ""}`,
    feel: null,
    charSide: "left",
    ...(perPanel?.[i] || {}),
  };
}

/**
 * renderPanels() — the strip/scroll view used by comic.html (the creator):
 * builds every panel up front and lays them out top to bottom so they can
 * all be reviewed/edited/exported at once. comic-view.html (the read-only
 * viewer) does NOT use this - see presentVisualNovel() below, which shows
 * one panel at a time with click-through dialogue instead of a scroll.
 */
/**
 * captionsForVN(photos) -> Promise<{text, feel, choices}[]>
 * Same Ink walk as captionsForPath(), but also captures real ink choices
 * (mapped to the path's next photo by id, when the choice's target knot
 * matches a photo id/"transit_generic" convention) instead of always
 * auto-picking the first one. Used only by the visual-novel viewer, which
 * needs to actually branch on them rather than flatten them into one
 * autogenerated caption. Falls back to captionsForPath()'s plain-caption
 * behavior (no choices) wherever Ink lookup fails.
 */
async function captionsForVN(photos) {
  let storyJson = null;
  try {
    const res = await fetch("data/story.ink.json");
    if (res.ok) storyJson = await res.json();
  } catch (err) {
    console.warn("data/story.ink.json not available - using plain captions.", err);
  }

  const photoIds = new Set(photos.map((p) => p.id));

  return photos.map((photo) => {
    const fallback = `${buildingLabel(photo)}${photo.year ? ` — ${photo.year}` : ""}`;
    if (!storyJson) return { text: fallback, feel: null, choices: [] };

    try {
      const story = new inkjs.Story(storyJson);
      try {
        story.ChoosePathString(photo.id);
      } catch (err) {
        story.ChoosePathString("transit_generic");
      }
      const lines = [];
      let feel = null;
      while (story.canContinue) {
        lines.push(story.Continue());
        for (const tag of story.currentTags) {
          const [key, ...rest] = tag.split(":").map((s) => s.trim());
          if (key === "feel") feel = rest.join(":").trim();
        }
      }
      const text = lines.join(" ").trim() || fallback;

      // Only surface choices that resolve to another photo in THIS path -
      // an ink choice pointing somewhere outside the plotted route has
      // nowhere to send the viewer, so it's dropped rather than shown as a
      // dead end.
      const choices = story.currentChoices
        .map((c) => {
          const targetId = (c.tags || []).find((t) => photoIds.has(t.trim()))?.trim();
          return targetId ? { text: c.text, nextId: targetId } : null;
        })
        .filter(Boolean);

      return { text, feel, choices };
    } catch (err) {
      console.warn(`Ink knot lookup failed for "${photo.id}" - using plain caption.`, err);
      return { text: fallback, feel: null, choices: [] };
    }
  });
}

async function renderPanels(photos, aspectValue, perPanel, statusEl, mode = "auto") {
  // perPanel: array (one entry per photo) of { filterStyle, captionText, feel, charSide }.
  // Autogenerate builds this array itself from a single global filter choice
  // and the Ink-derived captions; manual mode builds it from the per-panel
  // editors (see buildManualEditors()/collectManualSettings() below) so both
  // modes funnel through the exact same rendering code - "manual" only
  // changes where the settings come from, not how a panel gets drawn.
  const aspect = parseAspect(aspectValue);
  const panelsEl = document.getElementById("comic-panels");
  panelsEl.innerHTML = "";
  panelsEl.classList.remove("comic-panels--vn");
  renderedPanels = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const settings = resolvedSettings(photos, perPanel, i);
    statusEl.textContent = `Rendering panel ${i + 1} of ${photos.length}…`;

    const { panel, caption, canvas: panelCanvas } = await buildPanel(photo, i, photos.length, aspect, settings);

    renderedPanels.push({
      photo,
      canvas: panelCanvas,
      filterStyle: settings.filterStyle,
      captionText: settings.captionText,
      feel: settings.feel,
      charSide: settings.charSide,
    });

    panelsEl.appendChild(panel);

    // Typewriter starts once the panel is actually visible, so panels
    // further down the strip don't finish typing off-screen before the
    // player scrolls to them.
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          typewriter(caption, settings.captionText);
          observer.disconnect();
        }
      });
    }, { threshold: 0.4 });
    observer.observe(panel);
  }

  statusEl.textContent = `Done — ${photos.length} panels.`;
  lastRenderCtx = { photos, aspectValue, mode, perPanel };
  showSaveBar();
}

/**
 * buildVNPanel(photo, i, total, settings) -> Promise<{panel, caption, canvas}>
 * The viewer-only counterpart to buildPanel(): unlike the creator's strip
 * view, the VN viewer does NOT force-crop every photo to one shared aspect
 * ratio (recipe.aspect from the creator's dropdown is intentionally IGNORED
 * here). Instead each photo keeps its own natural aspect ratio - landscape
 * photos get a landscape frame, portrait photos get a portrait frame (see
 * "portrait or landscape depending on aspect ratio" in the brief) - shown
 * with object-fit: contain so nothing is cropped out, and the panel's own
 * background is set to that photo's sampled median color so any letterbox/
 * pillarbox bars read as an intentional backdrop instead of dead space.
 */
async function buildVNPanel(photo, i, total, settings) {
  const panel = document.createElement("div");
  panel.className = "comic-panel vn-panel";

  const img = document.createElement("img");
  img.className = "panel-bg";
  img.alt = buildingLabel(photo);

  let panelCanvas = null;
  try {
    const srcImg = await loadImage(photo.web || photo.file);
    if (settings.filterStyle === "none" || typeof stylizePhoto !== "function") {
      panelCanvas = srcImg; // stylizePhoto expects a canvas-like source; the raw <img> works fine as medianColor()'s/drawImage()'s source too
    } else {
      const { canvas, ditherStyle } = stylizePhoto(srcImg, { year: photo.year, lat: photo.lat, lon: photo.lon }, { ditherStyle: settings.filterStyle });
      panelCanvas = canvas;
      if (ditherStyle === "css-fallback") {
        img.classList.add("style-halftone");
        panel.dataset.stylizeFallback = "true";
      }
    }
    img.src = panelCanvas.toDataURL ? panelCanvas.toDataURL("image/png") : (photo.web || photo.file);
    panel.style.background = medianColor(panelCanvas);
    // --vn-ratio drives the CSS width/height math in .vn-panel--landscape/
    // --portrait (comic.css) - the photo's own aspect ratio, not a shared
    // crop ratio, so the frame itself is landscape- or portrait-shaped to
    // match this specific photo.
    const ratio = srcImg.width / srcImg.height;
    panel.style.setProperty("--vn-ratio", ratio);
    panel.classList.add(ratio >= 1 ? "vn-panel--landscape" : "vn-panel--portrait");
  } catch (err) {
    console.warn(`Could not load/filter "${photo.id}" - falling back to the unfiltered image.`, err);
    img.src = photo.styled || photo.web || photo.file;
    panel.style.background = "rgb(20, 20, 20)";
    panel.style.setProperty("--vn-ratio", 16 / 9);
    panel.classList.add("vn-panel--landscape");
  }
  panel.appendChild(img);

  renderCharacterPlaceholder(panel, settings.charSide);

  const textbox = document.createElement("div");
  textbox.className = "comic-textbox";
  const caption = document.createElement("span");
  caption.className = "caption-text";
  textbox.appendChild(caption);
  if (settings.feel) {
    const feelEl = document.createElement("span");
    feelEl.className = "feel-line";
    feelEl.textContent = settings.feel;
    textbox.appendChild(feelEl);
  }
  panel.appendChild(textbox);

  return { panel, caption, canvas: panelCanvas };
}

/**
 * buildCreditsScreen(photos) -> HTMLElement
 * The VN's final "page" - shown only once the story is finished (see
 * showPanelAt()/showAdvanceUI() below), reusing renderPathCredits()'s
 * markup/copy-button behavior but inside a VN-styled panel instead of the
 * creator page's always-visible strip.
 */
function buildCreditsScreen(photos) {
  const panel = document.createElement("div");
  panel.className = "comic-panel vn-panel vn-credits-screen";
  const inner = document.createElement("div");
  inner.className = "vn-credits-inner";
  panel.appendChild(inner);
  renderPathCredits(photos, inner);
  return panel;
}

/**
 * presentVisualNovel(photos, aspectValue, perPanel, statusEl, mode)
 * The comic-view.html read path: generate the same panels renderPanels()
 * would (same buildPanel() call, same settings resolution - "generate the
 * comic" step), but present them one at a time, full-frame, click-through,
 * instead of dumping the whole strip on screen together.
 *
 * Per panel:
 *   - the background image fills the frame (see .comic-panels--vn CSS)
 *   - the caption typewriter starts immediately (no scroll-into-view gate -
 *     there's nothing else on screen to scroll to)
 *   - clicking/tapping while typing fast-forwards the caption to completion;
 *     clicking again (or when a panel has no choices) advances to the next
 *     panel; clicking on the final panel shows an "end" state instead of
 *     advancing past the array
 *   - if perPanel[i].choices is present (see captionsForVN() below), the
 *     click-to-advance affordance is replaced with choice buttons, and
 *     picking one jumps to the chosen photo index rather than i + 1
 */
/**
 * presentVisualNovel(photos, aspectValue, perPanel, statusEl, mode)
 * The comic-view.html read path: generate the panels (same buildVNPanel()
 * call for every photo - "generate" step), but present them one at a time,
 * full-frame, click-through, instead of dumping the whole strip on screen
 * together. `aspectValue` (the creator's chosen crop ratio) is accepted for
 * signature/call-site compatibility with renderPanels() but NOT applied -
 * see buildVNPanel()'s doc comment for why the VN view uses each photo's
 * own natural aspect instead of one shared crop.
 *
 * Per panel:
 *   - the image is shown uncropped (object-fit: contain) inside a frame
 *     shaped to that photo's own aspect ratio, backed by its median color
 *   - the caption typewriter starts immediately (no scroll-into-view gate -
 *     there's nothing else on screen to scroll to), inside a textbox
 *     capped at a fraction of the frame's height so long captions never
 *     grow past the visible frame (see .comic-textbox in comic.css)
 *   - clicking/tapping while typing fast-forwards the caption to completion;
 *     clicking again (or when a panel has no choices) advances to the next
 *     panel; the credits screen (see buildCreditsScreen() above) is
 *     appended as one final "page" after the last photo, so credits show
 *     only once the story is actually finished, not up front
 *   - if perPanel[i].choices is present (see captionsForVN() below), the
 *     click-to-advance affordance is replaced with choice buttons, and
 *     picking one jumps to the chosen photo index rather than i + 1
 */
async function presentVisualNovel(photos, aspectValue, perPanel, statusEl, mode = "auto") {
  const panelsEl = document.getElementById("comic-panels");
  panelsEl.innerHTML = "";
  panelsEl.classList.add("comic-panels--vn");
  renderedPanels = [];

  statusEl.textContent = "Generating comic…";

  // Build every panel up front (this is the "generate" step) but only one
  // is ever attached/visible at a time (the "show" step), driven by
  // showPanelAt() below.
  const built = [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const settings = resolvedSettings(photos, perPanel, i);
    statusEl.textContent = `Generating panel ${i + 1} of ${photos.length}…`;
    const { panel, caption, canvas: panelCanvas } = await buildVNPanel(photo, i, photos.length, settings);
    built.push({ panel, caption, settings });
    renderedPanels.push({
      photo,
      canvas: panelCanvas,
      filterStyle: settings.filterStyle,
      captionText: settings.captionText,
      feel: settings.feel,
      charSide: settings.charSide,
    });
  }
  // The credits screen is the (built.length)-th "panel" - past the last
  // real photo - so it slots into the exact same showPanelAt()/click-to-
  // advance flow as everything else, with no separate end-state branch.
  const creditsPanel = buildCreditsScreen(photos);
  built.push({ panel: creditsPanel, caption: null, settings: { captionText: "", choices: [] } });

  statusEl.textContent = "";
  lastRenderCtx = { photos, aspectValue, mode, perPanel };

  let current = -1;
  let typing = null; // { done: boolean, finish: () => void } for the panel currently on screen

  function showPanelAt(i) {
    if (current >= 0) built[current].panel.remove();
    current = i;
    const { panel, caption, settings } = built[i];
    panelsEl.appendChild(panel);

    if (!caption) {
      // The credits screen has no typewriter/advance affordance of its own.
      typing = null;
      return;
    }

    let cancelled = false;
    typing = {
      done: false,
      finish() {
        cancelled = true;
        caption.textContent = settings.captionText;
        typing.done = true;
        showAdvanceUI(settings);
      },
    };
    caption.textContent = "";
    typewriter(caption, settings.captionText);
    // typewriter() (above) owns its own interval; give it a matching
    // "finished naturally" signal by polling completion via textContent
    // length rather than duplicating its timing logic here.
    const total = settings.captionText.length;
    const watch = setInterval(() => {
      if (cancelled) { clearInterval(watch); return; }
      if (caption.textContent.replace("▍", "").length >= total) {
        clearInterval(watch);
        typing.done = true;
        showAdvanceUI(settings);
      }
    }, 30);
  }

  function showAdvanceUI(settings) {
    const existing = built[current].panel.querySelector(".vn-choices, .vn-advance-hint");
    if (existing) return; // already shown for this panel
    if (settings.choices && settings.choices.length) {
      const box = document.createElement("div");
      box.className = "vn-choices";
      settings.choices.forEach((choice) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vn-choice-btn";
        btn.textContent = choice.text;
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const nextIndex = photos.findIndex((p) => p.id === choice.nextId);
          showPanelAt(nextIndex >= 0 ? nextIndex : Math.min(current + 1, built.length - 1));
        });
        box.appendChild(btn);
      });
      built[current].panel.appendChild(box);
    } else {
      // current + 1 always exists now - the credits screen is the last
      // entry in built[], so "next" from the final photo lands there
      // instead of a dead-end "The end" hint.
      const hint = document.createElement("div");
      hint.className = "vn-advance-hint";
      hint.textContent = current < built.length - 2 ? "Click to continue ▸" : "Click for credits ▸";
      built[current].panel.appendChild(hint);
    }
  }

  panelsEl.addEventListener("click", (evt) => {
    if (evt.target.closest(".vn-choice-btn, .attribution-copy-header, #attribution-plaintext")) return; // interactive elements handle their own clicks
    if (!typing) return; // credits screen: nothing to advance to
    if (!typing.done) {
      typing.finish();
      return;
    }
    const settings = built[current].settings;
    if (settings.choices && settings.choices.length) return; // must pick a choice, not click-through
    if (current < built.length - 1) showPanelAt(current + 1);
  });

  showPanelAt(0);
}

/**
 * buildManualEditors(photos, statusEl) — one editor block per path node:
 * a thumbnail, a per-panel filter dropdown, a left/right character-side
 * toggle, and a caption textarea pre-filled with the same Ink-derived text
 * autogenerate would use (editable before building). Ink lookup runs once
 * up front so every textarea starts populated instead of blank.
 */
async function buildManualEditors(photos, statusEl) {
  const host = document.getElementById("manual-panel-editors");
  if (host.dataset.built === "true") return; // only build once per page load - re-selecting the radio shouldn't wipe edits
  host.innerHTML = "";
  statusEl.textContent = "Loading story text for the editor…";
  const captions = await captionsForPath(photos);

  photos.forEach((photo, i) => {
    const row = document.createElement("div");
    row.className = "manual-editor-row";

    const thumb = document.createElement("img");
    thumb.className = "manual-editor-thumb";
    thumb.src = photo.thumb || photo.web || photo.file;
    thumb.alt = buildingLabel(photo);
    row.appendChild(thumb);

    const fields = document.createElement("div");
    fields.className = "manual-editor-fields";

    const heading = document.createElement("strong");
    heading.textContent = `${i + 1}. ${buildingLabel(photo)}${photo.year ? ` (${photo.year})` : ""}`;
    fields.appendChild(heading);

    const controlsRow = document.createElement("div");
    controlsRow.className = "manual-editor-controls";

    const filterSelect = document.createElement("select");
    filterSelect.className = "manual-filter-select";
    filterSelect.innerHTML = `
      <option value="halftone" selected>Halftone (ink dots)</option>
      <option value="dither">Ordered Dither</option>
      <option value="duotone">Duotone</option>
      <option value="none">None (cropped only)</option>`;
    controlsRow.appendChild(filterSelect);

    const sideSelect = document.createElement("select");
    sideSelect.className = "manual-side-select";
    sideSelect.innerHTML = `
      <option value="left" selected>Character: left</option>
      <option value="right">Character: right</option>
      <option value="center">Character: center</option>`;
    controlsRow.appendChild(sideSelect);
    fields.appendChild(controlsRow);

    const textarea = document.createElement("textarea");
    textarea.className = "manual-caption-textarea";
    textarea.rows = 3;
    textarea.value = captions[i].text;
    fields.appendChild(textarea);

    const feelInput = document.createElement("input");
    feelInput.type = "text";
    feelInput.className = "manual-feel-input";
    feelInput.placeholder = "Optional feel/acknowledgment line";
    feelInput.value = captions[i].feel || "";
    fields.appendChild(feelInput);

    row.appendChild(fields);
    host.appendChild(row);
  });

  host.dataset.built = "true";
  statusEl.textContent = "";
}

function collectManualSettings() {
  const rows = document.querySelectorAll("#manual-panel-editors .manual-editor-row");
  return Array.from(rows).map((row) => ({
    filterStyle: row.querySelector(".manual-filter-select").value,
    charSide: row.querySelector(".manual-side-select").value,
    captionText: row.querySelector(".manual-caption-textarea").value.trim(),
    feel: row.querySelector(".manual-feel-input").value.trim() || null,
  }));
}

/**
 * showSaveBar() — reveals #save-share-bar and wires its three buttons, once
 * (guarded by dataset.wired, same pattern buildManualEditors() uses). The
 * handlers always read the module-level lastRenderCtx/renderedPanels at
 * click time rather than closing over arguments, so re-generating the
 * comic (new aspect ratio, different mode, etc.) doesn't require
 * re-wiring - the buttons just act on whatever's on screen now.
 */
function showSaveBar() {
  if (document.body.dataset.page === "viewer") return;
  const bar = document.getElementById("save-share-bar");
  if (!bar) return;
  bar.hidden = false;
  if (bar.dataset.wired === "true") return;
  bar.dataset.wired = "true";

  document.getElementById("download-originals-btn").addEventListener("click", () => {
    if (lastRenderCtx) downloadOriginalsZip(lastRenderCtx.photos);
  });
  document.getElementById("download-finished-btn").addEventListener("click", downloadFinishedZip);
  document.getElementById("copy-link-btn").addEventListener("click", copyShareLink);
  const finishBtn = document.getElementById("open-finished-btn");
  if (finishBtn) finishBtn.addEventListener("click", openFinishedComic);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fetchAsBlob(url) {
  // Commons origin URLs already need to be fetchable/CORS-open for canvas
  // work (loadImage() above sets crossOrigin for the same reason), so this
  // is no new cross-origin assumption.
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.blob();
  });
}

function extFromUrl(url) {
  const match = url.split("?")[0].match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "jpg";
}

/**
 * downloadOriginalsZip(photos) — the best-available image per photo, plus a
 * credits.txt. `photo.id` is already the slugified Commons title (see
 * scripts/fetch-commons-images.mjs), so it doubles as a clean,
 * collision-free zip filename with no extra slugging.
 *
 * Prefers photo.file (the true full-resolution raw original) when it's
 * actually reachable - true locally during prep-day dev, since raw/ is
 * gitignored and never present on the deployed site. Falls back to
 * photo.web (the committed, compressed-but-still-sharp tier) so this
 * doesn't silently zip up nothing but a credits.txt once deployed.
 */
async function downloadOriginalsZip(photos) {
  const statusEl = document.getElementById("save-share-status");
  statusEl.textContent = "Zipping original photos…";
  const zip = new JSZip();
  for (const photo of photos) {
    const candidates = [photo.file, photo.web].filter(Boolean);
    let added = false;
    for (const src of candidates) {
      try {
        const blob = await fetchAsBlob(src);
        zip.file(`${photo.id}.${extFromUrl(src)}`, blob);
        added = true;
        break;
      } catch (err) {
        continue;
      }
    }
    if (!added) console.warn(`Could not fetch any image for "${photo.id}" - skipping it in the zip.`);
  }
  zip.file("credits.txt", photos.map(attributionLine).join("\n"));
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, "campus-comic-originals.zip");
  statusEl.textContent = "Downloaded original photos.";
}

/**
 * downloadFinishedZip() — flat PNGs of the visual panels (crop + filter +
 * character bbox rectangle), from renderedPanels' live canvases. Panels
 * whose image failed to load/crop/filter (canvas: null) are skipped rather
 * than exporting a blank/broken file.
 */
async function downloadFinishedZip() {
  const statusEl = document.getElementById("save-share-status");
  const entries = renderedPanels.filter((p) => p.canvas);
  if (!entries.length) {
    statusEl.textContent = "Nothing to export yet - generate the comic first.";
    return;
  }
  statusEl.textContent = "Zipping finished panels…";
  const zip = new JSZip();
  for (let i = 0; i < entries.length; i++) {
    const { photo, canvas, charSide } = entries[i];
    bakeOverlaysOntoCanvas(canvas, charSide);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob) zip.file(`${String(i + 1).padStart(2, "0")}-${photo.id}.png`, blob);
  }
  zip.file("credits.txt", entries.map((e) => attributionLine(e.photo)).join("\n"));
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, "campus-comic-finished.zip");
  statusEl.textContent = "Downloaded finished comic.";
}

/**
 * buildRecipe(photos, mode, aspectValue, perPanel) — the small JSON blob a
 * shareable link encodes. Auto mode deliberately omits caption/feel (they're
 * re-derived from data/story.ink.json on load, so an old link stays live if
 * the Ink story gets edited later); manual mode has to store them since
 * they're free text with no other source of truth.
 */
function buildRecipe(photos, mode, aspectValue, perPanel) {
  return {
    v: 1,
    mode,
    aspect: aspectValue,
    ids: photos.map((p) => p.id),
    panels: perPanel.map((s) =>
      mode === "auto"
        ? { filter: s.filterStyle }
        : { filter: s.filterStyle, side: s.charSide, caption: s.captionText, feel: s.feel }
    ),
  };
}

/**
 * copyShareLink() — encodes buildRecipe()'s output into location.hash and
 * copies the full URL. Long manual captions can make this link long; rather
 * than silently truncating (which would corrupt the recipe on decode), it
 * still copies the full link and just warns.
 */
async function copyShareLink() {
  const statusEl = document.getElementById("save-share-status");
  if (!lastRenderCtx) return;
  const { photos, mode, aspectValue, perPanel } = lastRenderCtx;
  const recipe = buildRecipe(photos, mode, aspectValue, perPanel);
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(recipe))));
  const viewerUrl = new URL("comic-view.html", location.href);
  viewerUrl.hash = `c=${encoded}`;

  statusEl.textContent =
    encoded.length > 2000
      ? "Long manual captions make this link long — consider shortening captions. Link copied anyway."
      : "Link copied.";

  try {
    await navigator.clipboard.writeText(viewerUrl.href);
  } catch (err) {
    console.warn("navigator.clipboard.writeText failed for the share link.", err);
    statusEl.textContent += " (Clipboard blocked - copy the address bar manually.)";
  }
}

function openFinishedComic() {
  if (!lastRenderCtx) return;
  const { photos, mode, aspectValue, perPanel } = lastRenderCtx;
  const recipe = buildRecipe(photos, mode, aspectValue, perPanel);
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(recipe))));
  location.href = `comic-view.html#c=${encoded}`;
}

/**
 * tryLoadFromHash() -> recipe object | null
 * Reads a `#c=<base64>` share link written by copyShareLink(). Returns null
 * (not throws) for "no link" and "malformed link" alike - both mean "fall
 * through to the normal localStorage path" to the caller.
 */
function tryLoadFromHash() {
  const match = location.hash.match(/c=([^&]+)/);
  if (!match) return null;
  try {
    const json = decodeURIComponent(escape(atob(match[1])));
    return JSON.parse(json);
  } catch (err) {
    console.warn("Malformed comic link.", err);
    return null;
  }
}

/**
 * renderFromRecipe(recipe) — the read-only reader path for a shared link:
 * resolve recipe.ids against the live data/photos.json (not whatever's in
 * this browser's localStorage), skip the editor UI entirely, and render.
 * Auto-mode recipes re-run captionsForPath() against the current
 * data/story.ink.json rather than storing caption text.
 */
async function renderFromRecipe(recipe) {
  const statusEl = document.getElementById("generate-status");
  // #comic-setup only exists on comic.html (the creator); comic-view.html
  // (the viewer) never renders it, so guard rather than assume it's there.
  const setupEl = document.getElementById("comic-setup");
  if (setupEl) setupEl.hidden = true;
  document.getElementById("no-path-message").hidden = true;

  let library = [];
  try {
    library = await loadJSON("data/photos.json");
  } catch (err) {
    console.error("Could not load data/photos.json for this shared link.", err);
    statusEl.textContent = "Could not load the photo library for this link.";
    return;
  }

  const libraryById = Object.fromEntries(library.map((p) => [p.id, p]));
  const photos = recipe.ids.map((id) => libraryById[id]).filter(Boolean);
  if (photos.length < 2) {
    statusEl.textContent = "This link's photos are no longer in the library.";
    return;
  }

  const viewerOnly = document.body.dataset.page === "viewer";
  // On the creator page credits are informational context shown up front;
  // on the immersive viewer they'd break the "just the story" framing, so
  // presentVisualNovel() shows them only once the story reaches its end
  // (see the credits screen built at the bottom of that function).
  if (!viewerOnly) renderPathCredits(photos);

  let perPanel;
  if (recipe.mode === "manual") {
    // Manual captions are free text with no Ink knot behind them, so there's
    // no branch data to offer - manual-mode links always play back linearly.
    perPanel = recipe.panels.map((p) => ({
      filterStyle: p.filter,
      charSide: p.side,
      captionText: p.caption,
      feel: p.feel,
      choices: [],
    }));
  } else {
    const captions = await captionsForVN(photos);
    perPanel = captions.map((c, i) => ({
      filterStyle: recipe.panels[i]?.filter || "halftone",
      charSide: "left",
      captionText: c.text,
      feel: c.feel,
      choices: c.choices,
    }));
  }

  // The hash (#c=...) IS this comic's unique id: decode it, generate the
  // panels from it, then hand off to the one-at-a-time visual-novel
  // presenter - not the editor's all-at-once scroll strip.
  await presentVisualNovel(photos, recipe.aspect, perPanel, statusEl, recipe.mode);
}

function loadPathFromStorage() {
  try {
    const raw = localStorage.getItem("ccc_comic_path");
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("Could not read ccc_comic_path from localStorage.", err);
    return [];
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  wireDarkMode();

  const recipe = tryLoadFromHash();
  const viewerOnly = document.body.dataset.page === "viewer";
  if (recipe) {
    await renderFromRecipe(recipe);
    return;
  }

  if (viewerOnly) {
    document.getElementById("generate-status").textContent = "Open a finished comic link to view it.";
    return;
  }

  const photos = loadPathFromStorage();
  if (!Array.isArray(photos) || photos.length < 2) {
    document.getElementById("no-path-message").hidden = false;
    document.getElementById("comic-setup").hidden = true;
    document.getElementById("credits-panel").hidden = true;
    return;
  }

  renderPathCredits(photos);

  const statusEl = document.getElementById("generate-status");
  const autogenOptions = document.getElementById("autogen-options");
  const manualOptions = document.getElementById("manual-options");

  document.querySelectorAll('input[name="comic-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const manual = radio.value === "manual" && radio.checked;
      if (!radio.checked) return;
      autogenOptions.hidden = manual;
      manualOptions.hidden = !manual;
      statusEl.textContent = "";
      if (manual) buildManualEditors(photos, statusEl);
    });
  });

  document.getElementById("generate-btn").addEventListener("click", async () => {
    const aspectValue = document.getElementById("aspect-ratio").value;
    const filterStyle = document.getElementById("filter-style").value;
    statusEl.textContent = "Writing captions…";
    try {
      const captions = await captionsForPath(photos);
      const perPanel = captions.map((c) => ({
        filterStyle,
        charSide: "left",
        captionText: c.text,
        feel: c.feel,
      }));
      await renderPanels(photos, aspectValue, perPanel, statusEl, "auto");
    } catch (err) {
      console.error("Comic generation failed.", err);
      statusEl.textContent = "Something went wrong generating the comic - check the console.";
    }
  });

  document.getElementById("build-manual-btn").addEventListener("click", async () => {
    const aspectValue = document.getElementById("aspect-ratio-manual").value;
    const perPanel = collectManualSettings();
    try {
      await renderPanels(photos, aspectValue, perPanel, statusEl, "manual");
    } catch (err) {
      console.error("Comic generation failed.", err);
      statusEl.textContent = "Something went wrong generating the comic - check the console.";
    }
  });
});
