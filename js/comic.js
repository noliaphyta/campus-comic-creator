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

function buildingLabel(photo) {
  if (photo.building) return photo.building;
  const base = (photo.title || photo.id || "Unknown")
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
  return base || "Unknown";
}

function attributionLine(photo) {
  const title = photo.title || buildingLabel(photo);
  const creator = photo.creator ? ` by ${photo.creator}` : "";
  const license = photo.license || "license unknown";
  const link = photo.source || "#";
  return `"${title}"${creator}, ${license}, via Wikimedia Commons - ${link}`;
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
  box.style.width = "26%";
  box.style.height = "55%";
  if (side === "right") box.style.right = "8%";
  else if (side === "center") { box.style.left = "37%"; }
  else box.style.left = "8%";
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

async function renderPanels(photos, aspectValue, perPanel, statusEl) {
  // perPanel: array (one entry per photo) of { filterStyle, captionText, feel, charSide }.
  // Autogenerate builds this array itself from a single global filter choice
  // and the Ink-derived captions; manual mode builds it from the per-panel
  // editors (see buildManualEditors()/collectManualSettings() below) so both
  // modes funnel through the exact same rendering code - "manual" only
  // changes where the settings come from, not how a panel gets drawn.
  const aspect = parseAspect(aspectValue);
  const panelsEl = document.getElementById("comic-panels");
  panelsEl.innerHTML = "";

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

    try {
      const srcImg = await loadImage(photo.file);
      const cropped = cropToAspect(srcImg, aspect.w, aspect.h);
      if (settings.filterStyle === "none" || typeof stylizePhoto !== "function") {
        img.src = cropped.toDataURL("image/png");
      } else {
        const { canvas } = stylizePhoto(cropped, { year: photo.year, lat: photo.lat, lon: photo.lon }, { ditherStyle: settings.filterStyle });
        img.src = canvas.toDataURL("image/png");
      }
    } catch (err) {
      console.warn(`Could not load/crop/filter "${photo.id}" - falling back to the raw image untouched.`, err);
      img.src = photo.styled || photo.file;
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

function loadPathFromStorage() {
  try {
    const raw = localStorage.getItem("ccc_comic_path");
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("Could not read ccc_comic_path from localStorage.", err);
    return [];
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wireDarkMode();

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
      await renderPanels(photos, aspectValue, perPanel, statusEl);
    } catch (err) {
      console.error("Comic generation failed.", err);
      statusEl.textContent = "Something went wrong generating the comic - check the console.";
    }
  });

  document.getElementById("build-manual-btn").addEventListener("click", async () => {
    const aspectValue = document.getElementById("aspect-ratio-manual").value;
    const perPanel = collectManualSettings();
    try {
      await renderPanels(photos, aspectValue, perPanel, statusEl);
    } catch (err) {
      console.error("Comic generation failed.", err);
      statusEl.textContent = "Something went wrong generating the comic - check the console.";
    }
  });
});
