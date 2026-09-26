/**
 * app.js — map/marker/timeline wiring + route plotting + story hookup.
 *
 * Owns SEQUENCE (which building is next, via the player's map route).
 * js/story.js owns CONTENT (what happens at a building). Don't blur this -
 * see the header comment in story.js.
 */

const CAMPUS_CENTER = [37.2712, -76.7112];
const CAMPUS_ZOOM = 16;

// Public OSRM demo server. Fine for a hackathon demo; rate-limited and not
// meant for production traffic - self-host OSRM if this ever needs to be
// reliable beyond a live judged demo.
const OSRM_BASE = "https://router.project-osrm.org/route/v1/foot";

let map;
let photosById = {};
let selectedWaypoints = []; // [{ lat, lon, buildingId }, ...] in click order
let routeLayer = null;
let markersLayer = null; // L.layerGroup holding the currently-visible photo markers
let yearRange = { min: null, max: null }; // current slider selection, inclusive

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

/**
 * photoMarkerIcon(photo) -> L.DivIcon
 * A small square thumbnail marker (photo.styled || photo.file) instead of a
 * generic pin - native Leaflet feature (L.divIcon), no extra dependency.
 */
function photoMarkerIcon(photo) {
  const src = photo.styled || photo.file;
  return L.divIcon({
    className: "photo-marker",
    html: src ? `<img src="${src}" alt="">` : "",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -22],
  });
}

async function init() {
  map = L.map("map").setView(CAMPUS_CENTER, CAMPUS_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  let photos = [];
  let buildings = null;

  try {
    photos = await loadJSON("data/photos.json");
  } catch (err) {
    console.warn("data/photos.json not found yet - using empty set.", err);
  }

  photosById = Object.fromEntries(photos.map((p) => [p.id, p]));
  window.__photosById = photosById; // read by story.js's renderPassage()

  try {
    buildings = await loadJSON("data/buildings.geojson");
    L.geoJSON(buildings, {
      style: { color: "#8a3324", weight: 1, fillOpacity: 0.05 },
    }).addTo(map);
  } catch (err) {
    console.warn("data/buildings.geojson not found yet - skipping footprints.", err);
  }

  markersLayer = L.layerGroup().addTo(map);

  if (photos.length) {
    renderYearRangeSlider(photos); // builds the slider AND does the first renderMarkers() call
  } else {
    document.getElementById("timeline-controls").hidden = true;
  }

  renderCredits(photos);
}

/**
 * renderMarkers(photos) — clears markersLayer and re-populates it with one
 * marker per photo that has usable coordinates. This is the single place
 * that actually puts photo pins on the map; both the initial load and every
 * slider move funnel through here so there's one code path to debug if a
 * pin doesn't show up (check: does the photo have numeric lat/lon? did
 * markersLayer get created before this was called?).
 */
function renderMarkers(photos) {
  markersLayer.clearLayers();
  photos.forEach((photo) => {
    if (typeof photo.lat !== "number" || typeof photo.lon !== "number") return;
    const marker = L.marker([photo.lat, photo.lon], { icon: photoMarkerIcon(photo) });
    marker.bindPopup(`<strong>${photo.building ?? "Unknown building"}</strong><br>${photo.year ?? "?"}`);
    marker.on("click", () => onPhotoSelected(photo));
    marker.addTo(markersLayer);
  });
}

// Fixed hit-area/visual width (px) shared by each pill handle AND the
// native <input type=range> thumb underneath it, so the browser's own
// thumb-centering math and our pill-centering math agree on where "the
// handle" actually is. See renderYearRangeSlider() below.
const YEAR_RANGE_PILL_WIDTH = 46;

/**
 * renderYearRangeSlider(photos) — builds a two-handled YEAR RANGE control
 * (min year + max year), not a single-position "current year" scrubber, with
 * a per-year photo-count histogram behind it so you can see where the data
 * actually is before you drag.
 *
 * Leaflet.timeline's stock L.TimelineSliderControl only exposes one moving
 * position on the timeline; with photosToGeoJSON() giving each photo a
 * start/end of just its own calendar year, that one position only ever
 * shows the (usually single) photo whose year contains it - stepping
 * through discrete years one at a time. With a dataset this small (8-12
 * curated photos, per docs/build-plan.md's "Image Sourcing" target) that
 * hides almost everything most of the time. A range - drag the low/high
 * handles to bracket a span of years and see every photo inside that span
 * at once - is a better fit, so this is a small dependency-free dual-range
 * control instead of Leaflet.timeline's slider.
 *
 * The two <input type=range> thumbs stay fully functional (mouse, touch,
 * keyboard arrows) but are made invisible; a plain <div class="year-range-
 * pill"> sitting on top of each one shows the selected year as text and is
 * what the user actually sees dragging. The pill and the native thumb are
 * both YEAR_RANGE_PILL_WIDTH px wide, so the browser's built-in thumb
 * placement and our JS pill placement land on the same pixel.
 */
function renderYearRangeSlider(photos) {
  const years = photos.map((p) => p.year).filter((y) => typeof y === "number");
  const el = document.getElementById("timeline-controls");
  el.innerHTML = "";

  if (!years.length) {
    el.hidden = true;
    renderMarkers(photos); // still show pins for photos that do have coords, just no year filter
    return;
  }

  el.hidden = false;
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const span = maxYear - minYear || 1; // avoid /0 when every photo is the same year
  yearRange = { min: minYear, max: maxYear };

  // Per-year counts feed the histogram bars. Years with zero photos still
  // get an (empty) column so the bar spacing lines up with the axis below.
  const counts = {};
  for (let y = minYear; y <= maxYear; y++) counts[y] = 0;
  years.forEach((y) => { counts[y] += 1; });
  const maxCount = Math.max(1, ...Object.values(counts));

  const wrap = document.createElement("div");
  wrap.className = "year-range";

  const label = document.createElement("div");
  label.className = "year-range-label";
  wrap.appendChild(label);

  // ---- histogram: one bar per calendar year (not per day - with a
  // dataset this size, day-level bins were tried and just looked noisy).
  // Bar height is sqrt-scaled so a single-photo year doesn't vanish next
  // to a busier one. ----
  const hist = document.createElement("div");
  hist.className = "year-histogram";
  const barCols = {};
  for (let y = minYear; y <= maxYear; y++) {
    const col = document.createElement("div");
    col.className = "year-histogram-col";
    const bar = document.createElement("div");
    bar.className = "year-histogram-bar";
    const h = counts[y] > 0 ? Math.max(10, Math.sqrt(counts[y] / maxCount) * 100) : 4;
    bar.style.height = h + "%";
    col.appendChild(bar);
    hist.appendChild(col);
    barCols[y] = col;
  }
  wrap.appendChild(hist);

  // ---- year axis: a tick per year, thinned out if there are a lot of
  // them, with the most recent year called out like a "latest" tag. ----
  const axis = document.createElement("div");
  axis.className = "year-axis";
  const axisYears = [];
  for (let y = minYear; y <= maxYear; y++) axisYears.push(y);
  const stride = Math.max(1, Math.ceil(axisYears.length / 10));
  axisYears.forEach((y, i) => {
    const show = i === 0 || i === axisYears.length - 1 || i % stride === 0;
    if (!show) return;
    const tick = document.createElement("span");
    tick.textContent = y;
    tick.style.left = (((y - minYear) / span) * 100) + "%";
    if (i === axisYears.length - 1) tick.classList.add("latest");
    axis.appendChild(tick);
  });
  wrap.appendChild(axis);

  // ---- track: a thin rail, a thin colored fill between the two handles
  // (not a thick bar - just the rail itself, recolored), and the two pill
  // handles on top. ----
  const track = document.createElement("div");
  track.className = "year-range-track";

  const rail = document.createElement("div");
  rail.className = "year-range-rail";
  const railFill = document.createElement("div");
  railFill.className = "year-range-rail-fill";
  track.appendChild(rail);
  track.appendChild(railFill);

  const minInput = document.createElement("input");
  minInput.type = "range";
  minInput.className = "year-range-input year-range-min";
  minInput.min = String(minYear);
  minInput.max = String(maxYear);
  minInput.value = String(minYear);

  const maxInput = document.createElement("input");
  maxInput.type = "range";
  maxInput.className = "year-range-input year-range-max";
  maxInput.min = String(minYear);
  maxInput.max = String(maxYear);
  maxInput.value = String(maxYear);

  const minPill = document.createElement("div");
  minPill.className = "year-range-pill";
  const maxPill = document.createElement("div");
  maxPill.className = "year-range-pill";

  track.appendChild(minInput);
  track.appendChild(maxInput);
  track.appendChild(minPill);
  track.appendChild(maxPill);
  wrap.appendChild(track);
  el.appendChild(wrap);

  // Centers `pill` at the px position the browser would center a
  // YEAR_RANGE_PILL_WIDTH-wide native thumb for this year value.
  function positionPill(pill, year) {
    pill.textContent = String(year);
    const trackWidth = track.clientWidth || 1;
    const pct = (year - minYear) / span;
    const half = YEAR_RANGE_PILL_WIDTH / 2;
    pill.style.left = (half + pct * (trackWidth - half * 2)) + "px";
  }

  // If every photo is the same year there's nothing to drag between - still
  // render the control (so the UI doesn't jump around if data changes
  // later), it just has one usable position.
  const updateLabelAndMarkers = () => {
    let lo = Math.min(Number(minInput.value), Number(maxInput.value));
    let hi = Math.max(Number(minInput.value), Number(maxInput.value));
    // Keep the two handles from crossing so "min" is always <= "max".
    minInput.value = String(lo);
    maxInput.value = String(hi);
    yearRange = { min: lo, max: hi };
    label.textContent = lo === hi ? `${lo}` : `${lo} – ${hi}`;

    const loPct = ((lo - minYear) / span) * 100;
    const hiPct = ((hi - minYear) / span) * 100;
    railFill.style.left = loPct + "%";
    railFill.style.right = (100 - hiPct) + "%";
    positionPill(minPill, lo);
    positionPill(maxPill, hi);

    for (let y = minYear; y <= maxYear; y++) {
      barCols[y].classList.toggle("in-range", y >= lo && y <= hi);
    }

    renderMarkers(photos.filter((p) => typeof p.year === "number" && p.year >= lo && p.year <= hi));
  };

  minInput.addEventListener("input", updateLabelAndMarkers);
  maxInput.addEventListener("input", updateLabelAndMarkers);
  // Pill positions are computed in px from the track's current width, so a
  // window resize (which the old plain-CSS-thumb version got for free)
  // needs an explicit repaint here.
  window.addEventListener("resize", updateLabelAndMarkers);

  updateLabelAndMarkers(); // initial paint: full range selected, all photos shown
}

/**
 * onPhotoSelected(photo) — click handler for a map pin. Two things happen:
 * 1. The photo is added to the player's path (selectedWaypoints).
 * 2. Once 2+ waypoints exist, plot the walking route between them and
 *    kick off the story at the first stop.
 */
function onPhotoSelected(photo) {
  selectedWaypoints.push({ lat: photo.lat, lon: photo.lon, buildingId: photo.id });
  renderWaypointChips();

  if (selectedWaypoints.length === 1) {
    runStylizeAndStory(photo);
  } else {
    plotRoute(selectedWaypoints).then(() => {
      runStylizeAndStory(photo);
    });
  }
}

function renderWaypointChips() {
  const el = document.getElementById("path-controls");
  el.innerHTML = "";
  selectedWaypoints.forEach((wp, i) => {
    const chip = document.createElement("span");
    chip.className = "waypoint-chip";
    chip.textContent = `${i + 1}. ${wp.buildingId}`;
    el.appendChild(chip);
  });
  if (selectedWaypoints.length > 0) {
    const clear = document.createElement("button");
    clear.textContent = "Clear path";
    clear.addEventListener("click", resetPath);
    el.appendChild(clear);

    // The route is open-ended (the player can keep clicking pins), so
    // there's no way to infer "last leg" from the map alone - the player
    // says when they're done, and that's what picks the epilogue variant.
    const finish = document.createElement("button");
    finish.textContent = "Finish walk";
    finish.addEventListener("click", () => {
      if (window.renderEpilogue) window.renderEpilogue();
    });
    el.appendChild(finish);
  }
}

function resetPath() {
  selectedWaypoints = [];
  renderWaypointChips();
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
}

/**
 * plotRoute(waypoints) — OSRM's /route service accepts an arbitrary-length
 * semicolon-separated coordinate list and returns the fastest route visiting
 * them IN ORDER, split into one `legs[]` entry per consecutive pair. One
 * call handles A->B->C->... ; you do not need one call per pair.
 */
async function plotRoute(waypoints) {
  const coords = waypoints.map((w) => `${w.lon},${w.lat}`).join(";");
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&steps=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM error ${res.status}`);
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) return null;

    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(route.geometry, { style: { color: "#1a1a1a", weight: 3, dashArray: "4 4" } });
    routeLayer.addTo(map);

    return route.legs; // one leg per consecutive waypoint pair
  } catch (err) {
    console.warn("OSRM route request failed - drawing straight lines instead.", err);
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(waypoints.map((w) => [w.lat, w.lon]), { color: "#1a1a1a", dashArray: "4 4" });
    routeLayer.addTo(map);
    return null;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * runStylizeAndStory(photo) — live-stylizes photo.file via stylize.js's
 * stylizePhoto() and caches the result onto photo.styled, THEN calls
 * jumpToBuilding(). story.js's renderPassage() already reads
 * `photo.styled || photo.file` for the background image, so updating
 * photo.styled here is what "sets #story-bg's image before invoking
 * jumpToBuilding" in practice - story.js doesn't need to know stylize.js
 * exists, keeping the map/content separation clean. If live stylization
 * fails (no WebGL, image didn't load, etc.) photo.styled is left alone and
 * renderPassage() falls back to the precomputed/raw image on its own.
 */
async function runStylizeAndStory(photo) {
  if (photo.file && typeof stylizePhoto === "function") {
    try {
      const img = await loadImage(photo.file);
      const { canvas, ditherStyle } = stylizePhoto(img, {
        year: photo.year,
        lat: photo.lat,
        lon: photo.lon,
      });
      photo.styled = canvas.toDataURL("image/png");
      const wrap = document.getElementById("story-bg-wrap");
      if (wrap) applyHalftoneCSS(wrap, ditherStyle === "halftone");
    } catch (err) {
      console.warn(`Live stylization failed for "${photo.id}" - using the precomputed/raw image instead.`, err);
    }
  }

  if (window.jumpToBuilding) {
    window.jumpToBuilding(photo.id);
  }
}

/**
 * renderCredits(photos) — auto-generates the attribution list from the
 * source/license metadata already captured per photo at ingest time. Don't
 * discard those fields when curating photos.json - this is where they're
 * used, not just provenance bookkeeping.
 */
function renderCredits(photos) {
  const el = document.getElementById("credits-panel");
  if (!photos.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const items = photos
    .map(
      (p) =>
        `<li>${p.building ?? "Unknown"}, ${p.year ?? "?"} — ${p.license ?? "license unknown"} — ` +
        `<a href="${p.source ?? "#"}" target="_blank" rel="noopener">source</a></li>`
    )
    .join("");
  el.innerHTML = `<strong>Credits</strong><ul>${items}</ul>`;
}

document.addEventListener("DOMContentLoaded", init);
