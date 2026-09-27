/**
 * stylize.js — the art pipeline.
 *
 * CHANGELOG (fixes applied after a stylization-system review — see
 * docs/build-plan.md):
 *   1. "halftone" now actually bakes colorHalftone() into the pixels
 *      (previously it relied on a CSS overlay that was only ever toggled
 *      on in js/app.js's map-click path, never in js/comic.js — so the
 *      same style looked different on the map vs. in a generated comic).
 *   2. "dither" now does REAL ordered/Bayer dithering. Previously "dither"
 *      called colorHalftone() too — a second halftone technique, not
 *      dithering — so true dithering (one of the originally requested
 *      style modules) didn't exist anywhere in the pipeline.
 *   3. colorHalftone()'s center coordinates are pixel coordinates per
 *      glfx's own docs, not a 0-1 fraction — fixed from (0.5, 0.5) to
 *      (canvas.width/2, canvas.height/2).
 *   4. A single shared WebGL context is now reused across every call
 *      instead of creating a fresh fx.canvas() per photo per generation.
 *      Three call sites (js/app.js, and two in js/comic.js) each used to
 *      spin up a new context with nothing ever disposed — a 5-6 photo
 *      path regenerated a couple of times in one session could realistically
 *      hit the browser's concurrent-WebGL-context ceiling (~16 in Chrome),
 *      after which fx.canvas() throws and later panels silently fell back
 *      to plain unfiltered photos with no visible indication why.
 *   5. kMeansPalette() is reinstated (it existed in an earlier pass of this
 *      pipeline and was dropped). It now drives: per-photo colorHalftone
 *      dot size (instead of every photo getting identical fixed params),
 *      the "dither" palette to quantize against, and a new "duotone" style.
 *
 * Libraries (both MIT, both loaded via CDN <script> — see index.html /
 * comic.html — no bundler needed):
 *   - glfx-es6 (https://evanw.github.io/glfx.js/docs/) — denoise() [flatten,
 *     bilateral-filter-like], ink() [linework], colorHalftone() [real CMYK-
 *     style halftone dots, pixel coordinates for center].
 *   - suncalc (https://github.com/mourner/suncalc) — SunCalc.getPosition()
 *     for sun altitude, driving lightingTint().
 *
 * Explicitly NOT built here (see docs/build-plan.md): procedural
 * watercolor, neural cartoonization, diffusion style transfer. Those stay
 * pre-baked-only or out of scope — never run live.
 */

const CAMPUS_LATLON = [37.2712, -76.7112]; // fallback if a photo has no lat/lon of its own

// One shared WebGL context for the page's whole session (fix #4 above).
// Created lazily on first use. If WebGL truly isn't available at all,
// creation fails once, is reported once, and every subsequent call takes
// the css-fallback path uniformly — no more "some panels styled, some
// not" inconsistency from exhausting a per-photo context budget.
let sharedGlCanvas;
let glCanvasUnavailable = false;

function getGlCanvas() {
  if (glCanvasUnavailable) throw new Error("WebGL previously failed for this session");
  if (sharedGlCanvas) return sharedGlCanvas;
  try {
    sharedGlCanvas = fx.canvas();
    return sharedGlCanvas;
  } catch (err) {
    glCanvasUnavailable = true;
    throw err;
  }
}

/**
 * lightingTint(meta) -> { r, g, b, alpha }
 * meta: { year, lat, lon, date? }. Photos only carry a `year`, not a
 * timestamp, so absent an explicit meta.date this assumes a fall-semester
 * campus-visit hour (Sept 15, 3pm) for that year — a reasonable stand-in
 * for "a photo taken while W&M was in session," not a claim about the
 * actual shot time. Pass meta.date (ISO string) to override per-photo.
 */
function lightingTint(meta = {}) {
  if (typeof SunCalc === "undefined") return { r: 255, g: 255, b: 255, alpha: 0 };

  const lat = meta.lat ?? CAMPUS_LATLON[0];
  const lon = meta.lon ?? CAMPUS_LATLON[1];
  const year = meta.year ?? new Date().getFullYear();
  const date = meta.date ? new Date(meta.date) : new Date(year, 8, 15, 15, 0);

  const { altitude } = SunCalc.getPosition(date, lat, lon); // radians (suncalc 1.9.x)
  const altitudeDeg = (altitude * 180) / Math.PI;

  if (altitudeDeg <= 0) return { r: 40, g: 60, b: 120, alpha: 0.35 }; // sun below horizon: cool night tint
  if (altitudeDeg < 10) return { r: 255, g: 150, b: 60, alpha: 0.28 }; // golden hour: warm tint
  return { r: 255, g: 244, b: 214, alpha: 0.1 }; // high sun: light warm-white wash
}

/**
 * kMeansPalette(imageData, k) -> [{ r, g, b }, ...]
 * Small, fast palette extraction over a downsampled pixel set (every 8th
 * pixel) so it stays cheap even when run per-photo across a whole path.
 * Seeded from evenly spaced samples rather than random for deterministic
 * results across runs of the same photo.
 */
function kMeansPalette(imageData, k = 5) {
  const { data } = imageData;
  const samples = [];
  for (let i = 0; i < data.length; i += 4 * 8) {
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (samples.length === 0) return [];

  let centroids = Array.from({ length: k }, (_, i) =>
    samples[Math.floor((i / k) * samples.length)].slice()
  );

  for (let iter = 0; iter < 8; iter++) {
    const buckets = Array.from({ length: k }, () => []);
    for (const s of samples) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d =
          (s[0] - centroids[c][0]) ** 2 +
          (s[1] - centroids[c][1]) ** 2 +
          (s[2] - centroids[c][2]) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      buckets[best].push(s);
    }
    centroids = buckets.map((bucket, c) => {
      if (bucket.length === 0) return centroids[c];
      const sum = bucket.reduce((a, s) => [a[0] + s[0], a[1] + s[1], a[2] + s[2]], [0, 0, 0]);
      return [sum[0] / bucket.length, sum[1] / bucket.length, sum[2] / bucket.length];
    });
  }

  return centroids.map(([r, g, b]) => ({ r: Math.round(r), g: Math.round(g), b: Math.round(b) }));
}

/**
 * orderedDither(imageData, palette) -> ImageData
 * Real Bayer/ordered dithering against the extracted palette — this is
 * what the "dither" style option now actually does (see changelog #2).
 * Reference algorithm set: https://github.com/allen-garvey/dithermark
 */
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function nearestPaletteColor(r, g, b, palette) {
  let best = palette[0];
  let bestDist = Infinity;
  for (const c of palette) {
    const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function orderedDither(imageData, palette) {
  if (!palette || palette.length === 0) return imageData;
  const { data, width, height } = imageData;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const threshold = (BAYER_4X4[y % 4][x % 4] / 16 - 0.5) * 64;
      const c = nearestPaletteColor(data[i] + threshold, data[i + 1] + threshold, data[i + 2] + threshold, palette);
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
    }
  }
  return imageData;
}

/**
 * duotoneMap(imageData, dark, light) -> ImageData
 * Maps each pixel's luminance onto a gradient between two colors — the
 * cheapest genuinely distinct 4th style, using the extracted palette's
 * darkest/lightest swatch by default (see stylizePhoto()) rather than a
 * fixed pair, so it still reflects each photo's own tones.
 */
function duotoneMap(imageData, dark, light) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    data[i] = dark.r + (light.r - dark.r) * lum;
    data[i + 1] = dark.g + (light.g - dark.g) * lum;
    data[i + 2] = dark.b + (light.b - dark.b) * lum;
  }
  return imageData;
}

/**
 * applyHalftoneCSS(targetEl) — WebGL-unavailable fallback ONLY now (see
 * changelog #1). The real halftone effect is colorHalftone(), baked into
 * pixels by stylizePhoto() below. This CSS overlay is what a caller should
 * apply when stylizePhoto() returns ditherStyle: "css-fallback", so there's
 * still some visible stylization when WebGL genuinely isn't available,
 * rather than a plain unfiltered photo with no indication anything is
 * different about it.
 */
function applyHalftoneCSS(targetEl, on = true) {
  targetEl.classList.toggle("style-halftone", on);
}

/**
 * stylizePhoto(imgElement, meta, opts) -> { canvas, palette, ditherStyle }
 * Runs the full pipeline client-side.
 *
 * meta: { year, lat, lon, date? } — feeds lightingTint().
 * opts.ditherStyle: "halftone" (default, colorHalftone) | "dither" (ordered
 * dither) | "duotone" | "none".
 *
 * ditherStyle in the return value is normally an echo of opts.ditherStyle,
 * EXCEPT it comes back as "css-fallback" if WebGL isn't available at all —
 * callers should check for that value and apply applyHalftoneCSS() (or
 * otherwise visibly indicate reduced styling) rather than silently
 * treating it as a plain photo.
 */
function stylizePhoto(imgElement, meta = {}, opts = {}) {
  const ditherStyle = opts.ditherStyle || "halftone";
  const w = imgElement.naturalWidth || imgElement.width;
  const h = imgElement.naturalHeight || imgElement.height;

  // Palette from the RAW image, before any filtering — needed by "dither"
  // and "duotone", and also now varies "halftone"'s dot size per photo.
  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = w;
  rawCanvas.height = h;
  const rawCtx = rawCanvas.getContext("2d");
  rawCtx.drawImage(imgElement, 0, 0, w, h);
  const palette = kMeansPalette(rawCtx.getImageData(0, 0, w, h));

  let glCanvas;
  try {
    glCanvas = getGlCanvas();
  } catch (err) {
    console.warn("WebGL unavailable this session - using the CSS halftone fallback for every photo.", err);
    return { canvas: rawCanvas, palette, ditherStyle: "css-fallback" };
  }

  const texture = glCanvas.texture(imgElement);
  let chain = glCanvas.draw(texture).denoise(20).ink(0.25);

  if (ditherStyle === "halftone") {
    // Per-photo variation instead of identical fixed params for every
    // photo: brighter photos get slightly larger dots. Coordinates are
    // pixel-space per glfx's docs (fix #3 above) - not a 0-1 fraction.
    const avgBrightness = palette.length
      ? palette.reduce((sum, c) => sum + (c.r + c.g + c.b) / 3, 0) / palette.length
      : 128;
    const size = 3 + Math.round((avgBrightness / 255) * 3); // ~3-6px dots
    chain = chain.colorHalftone(glCanvas.width / 2, glCanvas.height / 2, Math.PI / 12, size);
  }
  chain.update();

  const canvas = document.createElement("canvas");
  canvas.width = glCanvas.width;
  canvas.height = glCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(glCanvas, 0, 0);
  // Free this photo's GPU texture now that it's baked into `canvas` as
  // pixels - the shared glCanvas WebGL CONTEXT stays alive for reuse by
  // the next photo (that's the actual fix for the context-leak issue;
  // texture.destroy() alone wouldn't have been enough, since a fresh
  // fx.canvas() per photo was the real source of context exhaustion).
  texture.destroy();

  if (ditherStyle === "dither") {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.putImageData(orderedDither(imageData, palette), 0, 0);
  } else if (ditherStyle === "duotone") {
    const sorted = [...palette].sort((a, b) => a.r + a.g + a.b - (b.r + b.g + b.b));
    const dark = sorted[0] || { r: 20, g: 20, b: 30 };
    const light = sorted[sorted.length - 1] || { r: 250, g: 240, b: 220 };
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.putImageData(duotoneMap(imageData, dark, light), 0, 0);
  }

  const tint = lightingTint(meta);
  if (tint.alpha > 0) {
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${tint.alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  }

  return { canvas, palette, ditherStyle };
}
