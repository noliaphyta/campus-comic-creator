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
 * renderPathCredits(photos) — same copy-pastable attribution block as the
 * map page (js/app.js's renderCredits()), but scoped to ONLY the photos in
 * this path, in path order, since that's the set this specific comic
 * actually uses.
 */
function renderPathCredits(photos) {
  const el = document.getElementById("credits-panel");
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
  document.getElementById("attribution-plaintext").textContent = plainText;

  const copyBtn = document.getElementById("copy-credits-btn");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      copyBtn.textContent = "Copied!";
    } catch (err) {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("attribution-plaintext"));
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
  renderedPanels = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const settings = perPanel[i];
    statusEl.textContent = `Rendering panel ${i + 1} of ${photos.length}…`;

    const panel = document.createElement("div");
    panel.className = "comic-panel";
    panel.style.aspectRatio = aspect.css;

    const idx = document.createElement("span");
    idx.className = "panel-index";
    idx.textContent = `${i + 1} / ${photos.length}`;
    panel.appendChild(idx);

    const img = document.createElement("img");
    img.className = "panel-bg";
    img.alt = buildingLabel(photo);

    let panelCanvas = null; // set below on success; stays null if load/crop/filter failed
    try {
      const srcImg = await loadImage(photo.file);
      const cropped = cropToAspect(srcImg, aspect.w, aspect.h);
      if (settings.filterStyle === "none" || typeof stylizePhoto !== "function") {
        panelCanvas = cropped;
      } else {
        const { canvas } = stylizePhoto(cropped, { year: photo.year, lat: photo.lat, lon: photo.lon }, { ditherStyle: settings.filterStyle });
        panelCanvas = canvas;
      }
      img.src = panelCanvas.toDataURL("image/png");
    } catch (err) {
      console.warn(`Could not load/crop/filter "${photo.id}" - falling back to the raw image untouched.`, err);
      img.src = photo.styled || photo.file;
    }
    panel.appendChild(img);

    renderedPanels.push({
      photo,
      canvas: panelCanvas,
      filterStyle: settings.filterStyle,
      captionText: settings.captionText,
      feel: settings.feel,
      charSide: settings.charSide,
    });

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

    panelsEl.appendChild(panel);

    // Typewriter starts once the panel is actually visible, so panels
    // further down the strip don't finish typing off-screen before the
    // player scrolls to them - a cheap stand-in for real page/scene
    // transitions until this becomes an actual paginated visual-novel view.
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
    thumb.src = photo.thumb || photo.file;
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
      <option value="dither">CMYK dither</option>
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
 * downloadOriginalsZip(photos) — the untouched, full-resolution Commons
 * originals for this path, plus a credits.txt. `photo.id` is already the
 * slugified Commons title (see scripts/fetch-commons-images.mjs), so it
 * doubles as a clean, collision-free zip filename with no extra slugging.
 */
async function downloadOriginalsZip(photos) {
  const statusEl = document.getElementById("save-share-status");
  statusEl.textContent = "Zipping original photos…";
  const zip = new JSZip();
  for (const photo of photos) {
    try {
      const blob = await fetchAsBlob(photo.file);
      zip.file(`${photo.id}.${extFromUrl(photo.file)}`, blob);
    } catch (err) {
      console.warn(`Could not fetch the original for "${photo.id}" - skipping it in the zip.`, err);
    }
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
  location.hash = `c=${encoded}`;

  statusEl.textContent =
    encoded.length > 2000
      ? "Long manual captions make this link long — consider shortening captions. Link copied anyway."
      : "Link copied.";

  try {
    await navigator.clipboard.writeText(location.href);
  } catch (err) {
    console.warn("navigator.clipboard.writeText failed for the share link.", err);
    statusEl.textContent += " (Clipboard blocked - copy the address bar manually.)";
  }
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
  document.getElementById("comic-setup").hidden = true;
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

  renderPathCredits(photos);

  let perPanel;
  if (recipe.mode === "manual") {
    perPanel = recipe.panels.map((p) => ({
      filterStyle: p.filter,
      charSide: p.side,
      captionText: p.caption,
      feel: p.feel,
    }));
  } else {
    const captions = await captionsForPath(photos);
    perPanel = captions.map((c, i) => ({
      filterStyle: recipe.panels[i]?.filter || "halftone",
      charSide: "left",
      captionText: c.text,
      feel: c.feel,
    }));
  }

  await renderPanels(photos, recipe.aspect, perPanel, statusEl, recipe.mode);
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
  if (recipe) {
    await renderFromRecipe(recipe);
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
