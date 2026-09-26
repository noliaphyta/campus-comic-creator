/**
 * stylize.js — the art pipeline.
 *
 * Pipeline (Canvas/WebGL via glfx-es6, MIT, https://www.npmjs.com/package/glfx-es6):
 *   1. denoise()      -> flattens grain/noise, same job as a bilateral filter
 *   2. ink()          -> comic linework pass (glfx's built-in pen-and-ink filter)
 *   3. colorHalftone() [only for the "dither" style toggle] -> CMYK dot-screen
 *   4. suncalc lighting tint -> composited on top with a 2D context
 *
 * glfx-es6 ships denoise/edgeWork/ink/colorHalftone as real WebGL shaders, so
 * none of bilateralFilter/kMeansPalette/edgeOverlay/orderedDither are
 * hand-rolled here — that was the point of pulling in the library instead of
 * writing a k-means loop and a Bayer matrix by hand. "halftone" (the default,
 * cheapest style) stays a pure CSS class toggle via applyHalftoneCSS(), zero
 * canvas cost; "dither" reuses the same WebGL pipeline's colorHalftone() filter.
 *
 * suncalc (MIT, https://github.com/mourner/suncalc, pinned to 1.9.x on the
 * CDN <script> tag — this version's getPosition() returns altitude/azimuth
 * in radians) drives lightingTint(): how high the sun was over campus tints
 * the scene warm (low sun / golden hour) or cool (sun below the horizon).
 *
 * Explicitly NOT built here (see build plan): procedural watercolor,
 * neural cartoonization, diffusion style transfer. Those stay pre-baked-only
 * or out of scope — never run live.
 */

const CAMPUS_LATLON = [37.2712, -76.7112]; // fallback if a photo has no lat/lon of its own

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
 * stylizePhoto(imgElement, meta, opts) -> { canvas, ditherStyle }
 * Runs the full pipeline client-side. This is what onPhotoSelected() in
 * app.js calls on marker click for the live-demo moment.
 *
 * meta: { year, lat, lon, date? } — feeds lightingTint().
 * opts.ditherStyle: "halftone" | "dither" | "none" (default "halftone" —
 * it's the cheaper of the two and has zero canvas-pixel risk during a demo).
 */
function stylizePhoto(imgElement, meta = {}, opts = {}) {
  const ditherStyle = opts.ditherStyle || "halftone";

  const glCanvas = fx.canvas();
  const texture = glCanvas.texture(imgElement);
  let chain = glCanvas.draw(texture).denoise(20).ink(0.25);
  if (ditherStyle === "dither") {
    chain = chain.colorHalftone(0.5, 0.5, 0, 4);
  }
  chain.update();

  // Composite the suncalc lighting tint on top via a plain 2D canvas — glfx
  // owns the WebGL canvas, but a flat color-over blend doesn't need WebGL.
  const canvas = document.createElement("canvas");
  canvas.width = glCanvas.width;
  canvas.height = glCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(glCanvas, 0, 0);

  const tint = lightingTint(meta);
  if (tint.alpha > 0) {
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${tint.alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  }

  return { canvas, ditherStyle };
}
