/**
 * stylize.js — the art pipeline.
 *
 * Pipeline order (finalized plan):
 *   1. bilateral filter    -> flatten/quantize the background
 *   2. k-means palette     -> extract 4-6 dominant colors
 *   3. edge/line overlay   -> comic linework layer
 *   4. one of: halftone (CSS) | ordered dither (canvas, reuses palette)
 *   5. suncalc lighting tint -> tint based on the photo's date + campus coords
 *
 * Steps 4 is a *choice*, not an addition — pick one per photo/style toggle,
 * don't stack both. Halftone is the cheapest possible option (a CSS class
 * toggle, no pixel work); ordered dither is the next cheapest (one nested
 * loop, reuses the k-means palette already computed in step 2). Both are
 * "always fast, always works" and safe to run live during judging.
 *
 * Explicitly NOT built here (see build plan): procedural watercolor,
 * neural cartoonization, diffusion style transfer. Those stay pre-baked-only
 * or out of scope — never run live.
 */

function bilateralFilter(ctx, width, height, opts = {}) {
  // TODO: classic bilateral filter over the ImageData. Placeholder no-op.
  return ctx.getImageData(0, 0, width, height);
}

/**
 * kMeansPalette(imageData, k) -> [{ r, g, b }, ...]
 * Extracts a small dominant-color palette. Reused by both the edge overlay
 * (linework color) and the ordered-dither pass (so dithering reflects each
 * photo's own extracted mood instead of a fixed generic palette).
 */
function kMeansPalette(imageData, k = 5) {
  // TODO: k-means over pixel colors, return an array of { r, g, b } of length k.
  return [];
}

function edgeOverlay(ctx, width, height) {
  // TODO: Sobel/Canny-style edge pass, composited as a dark linework layer.
  return ctx.getImageData(0, 0, width, height);
}

/**
 * applyHalftoneCSS(targetEl) — cheapest halftone option.
 * Ports the leanrada.com pure-CSS technique: a radial-gradient dot pattern
 * blended with `mix-blend-mode: screen`, thresholded via `filter: contrast(999)`.
 * This does NOT touch canvas pixels at all — it toggles a class on the
 * element wrapping the canvas/img. See css/style.css `.style-halftone`.
 */
function applyHalftoneCSS(targetEl, on = true) {
  targetEl.classList.toggle("style-halftone", on);
}

/**
 * orderedDither(imageData, palette) -> ImageData
 * Bayer/ordered dithering against a supplied palette (pass the output of
 * kMeansPalette here — see the module doc above for why). Reference
 * algorithm set: https://github.com/allen-garvey/dithermark
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
  if (!palette || palette.length === 0) return imageData; // no palette yet, no-op
  const { data, width, height } = imageData;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const threshold = (BAYER_4X4[y % 4][x % 4] / 16 - 0.5) * 64; // spread ~ +-32
      const r = data[i] + threshold;
      const g = data[i + 1] + threshold;
      const b = data[i + 2] + threshold;
      const c = nearestPaletteColor(r, g, b, palette);
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
    }
  }
  return imageData;
}

function lightingTint(date) {
  // TODO: use suncalc (https://github.com/mourner/suncalc) with the photo's
  // lat/lon/date to derive a warm/cool tint for the time of day + season.
  return { r: 255, g: 255, b: 255, alpha: 0 };
}

/**
 * stylizePhoto(imgElement, meta, opts) -> canvas
 * Runs the full pipeline client-side. This is what onPhotoSelected() in
 * app.js calls on marker click for the live-demo moment.
 *
 * opts.ditherStyle: "halftone" | "dither" | "none" (default "halftone" —
 * it's the cheaper of the two and has zero canvas-pixel risk during a demo).
 */
function stylizePhoto(imgElement, meta = {}, opts = {}) {
  const ditherStyle = opts.ditherStyle || "halftone";

  const canvas = document.createElement("canvas");
  canvas.width = imgElement.naturalWidth;
  canvas.height = imgElement.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgElement, 0, 0);

  bilateralFilter(ctx, canvas.width, canvas.height);
  const palette = kMeansPalette(ctx.getImageData(0, 0, canvas.width, canvas.height));
  edgeOverlay(ctx, canvas.width, canvas.height);

  if (ditherStyle === "dither") {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.putImageData(orderedDither(imageData, palette), 0, 0);
  }
  // ditherStyle === "halftone" is applied by the caller via applyHalftoneCSS()
  // on the wrapping element, not here — it's a CSS-layer effect, not canvas.

  // TODO: composite lightingTint(meta.date) over the canvas.

  return { canvas, palette, ditherStyle };
}
