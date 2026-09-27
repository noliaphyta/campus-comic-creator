/**
 * app.js — map/marker/timeline wiring + route plotting + story hookup.
 *
 * Owns SEQUENCE (which building is next, via the player's map route).
 * js/story.js owns CONTENT (what happens at a building). Don't blur this -
 * see the header comment in story.js.
 */

const CAMPUS_CENTER = [37.2712, -76.7112];
const CAMPUS_ZOOM = 16;

// The timeline never scrolls back further than this, regardless of how far
// back the actual photo data goes - see renderYearRangeSlider() below.
const TIMELINE_EARLIEST_YEAR = 2001;

// Profile-specific OSRM endpoints from routing.openstreetmap.de. The public
// router.project-osrm.org endpoint accepted the profile names but returned
// identical routes for this campus, so the service host must be selected with
// the profile. Profile is picked by the user (see #route-profile).
//
// IMPORTANT: the service is public and rate-limited. plotRoute() throttles
// itself to roughly one request/second (see ROUTE_MIN_INTERVAL_MS and
// throttleRouteRequest below), so rapid profile changes and pin clicks do not
// create an avoidable burst of requests.
const OSRM_ENDPOINTS = {
  foot: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  bike: "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
  driving: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
};
const ROUTE_MIN_INTERVAL_MS = 1100;

// Dedicated pedestrian ways (see scripts/fetch-footpaths-overpass.mjs). Used
// only to explain routing results, not to route - if this layer is empty
// near a plotted route, that's a strong signal OSM has no mapped campus
// footpaths there and the "foot" profile is falling back to the road
// network, which is what makes a walking route look like a driving route.
const PATHS_GEOJSON = "data/paths.geojson";
// Rough degrees-per-meter buffer (~120m) for the "are there footpaths near
// this route" bbox check below; doesn't need to be precise, just a sanity
// radius, since this is a heuristic explanation, not a routing input.
const NEARBY_PATH_BUFFER_DEG = 0.0011;

let map;
let photosById = {};
let selectedWaypoints = []; // [{ lat, lon, buildingId }, ...] in click order
let routeLayer = null;
let routeProfile = "foot"; // foot | bike | driving - see #route-profile select
let markersLayer = null; // L.layerGroup holding Tier A (thumbnail) markers
let dotCluster = null; // L.markerClusterGroup holding Tier B (dot) markers
let yearRange = { min: null, max: null }; // current slider selection, inclusive
let footpathFeatures = []; // raw LineString features from data/paths.geojson, [] if not fetched yet
let buildingsLayer = null; // L.geoJSON layer for data/buildings.geojson - always on, no toggle anymore
let pathsLayer = null; // L.geoJSON layer for data/paths.geojson - always on, no toggle anymore
let routeRequestSeq = 0; // increments per plotRoute() call; guards against out-of-order/superseded responses
let lastRouteRequestAt = 0; // Date.now() of the last OSRM fetch actually sent; see throttleRouteRequest()

// ---- Two-tier markers + reshuffle pagination state ----
// Tier A gets a real thumbnail marker (touches Wikimedia's thumbnail
// servers); Tier B gets a plain clustered dot. Capping Tier A at a fixed
// batch size is what keeps thumbnail requests from scaling with dataset
// size - see renderMarkers()/drawNextBatch() below.
let currentFilteredPhotos = []; // the photos passing the current year filter
let shuffleQueue = []; // remaining photos for this filter, diversity-shuffled
let shuffleBatches = []; // batches already drawn this session, in order
let batchIndex = -1; // which entry of shuffleBatches is on screen now

function tierASize() {
  return Math.max(8, Math.min(30, Math.round(window.innerWidth / 55)));
}

/**
 * photoDisplayName(photo) — buildingLabel() (js/shared.js) plus the year,
 * for spots (waypoint chips, filmstrip captions) that want both in one
 * string.
 */
function photoDisplayName(photo) {
  const label = buildingLabel(photo);
  return photo.year ? `${label} (${photo.year})` : label;
}

// Coarse ~100m grid cell - used to diversify a batch when `building` is
// null (the common case until buildings.geojson has real polygons), so two
// photos of the same spot don't cluster together in the interleave below.
function diversityKey(photo) {
  return photo.building ? `b:${photo.building}` : `g:${Math.round(photo.lat * 1000)},${Math.round(photo.lon * 1000)}`;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Round-robins across diversity groups (each pre-shuffled) so page 1 isn't
// 20 photos of the same building/event.
function shuffledDiverse(photos) {
  const groups = new Map();
  shuffle(photos).forEach((p) => {
    const k = diversityKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });
  const buckets = shuffle([...groups.values()]);
  const out = [];
  let i = 0;
  while (out.length < photos.length) {
    const bucket = buckets[i % buckets.length];
    if (bucket.length) out.push(bucket.shift());
    i++;
    if (buckets.every((b) => b.length === 0)) break;
  }
  return out;
}

// loadJSON() now lives in js/shared.js (loaded before this file).

/**
 * photoMarkerIcon(photo) -> L.DivIcon
 * A small square thumbnail marker (photo.thumb, falling back to styled/web/
 * file) instead of a generic pin - native Leaflet feature (L.divIcon), no
 * extra dependency. Thumb first: it's the smallest tier and this is a
 * 44x44px icon, no reason to pull a bigger image for it. This was the
 * actual map-thumbnail bug: it never looked at photo.thumb at all before,
 * only styled/file - so it always tried (and 404'd on) the big/gitignored
 * image instead of the small committed one.
 */
function photoMarkerIcon(photo) {
  const src = photo.thumb || photo.styled || photo.web || photo.file;
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
  const dataset = new URLSearchParams(window.location.search).get("dataset");
  const photosPath = dataset === "test" ? "data/photos.scaffold.json" : "data/photos.json";

  try {
    photos = await loadJSON(photosPath);
  } catch (err) {
    console.warn(`${photosPath} not found yet - using empty set.`, err);
  }

  photosById = Object.fromEntries(photos.map((p) => [p.id, p]));
  window.__photosById = photosById; // read by story.js's renderPassage()

  try {
    buildings = await loadJSON("data/buildings.geojson");
    buildingsLayer = L.geoJSON(buildings, {
      style: { color: "#8a3324", weight: 1, fillOpacity: 0.05 },
    }).addTo(map);
  } catch (err) {
    console.warn("data/buildings.geojson not found yet - skipping footprints.", err);
  }

  try {
    const paths = await loadJSON(PATHS_GEOJSON);
    footpathFeatures = paths.features || [];
    pathsLayer = L.geoJSON(paths, {
      style: { color: "#2b6cb0", weight: 2, opacity: 0.6, dashArray: "1 4" },
    }).addTo(map);
  } catch (err) {
    footpathFeatures = [];
    console.warn(
      `${PATHS_GEOJSON} not found yet - skipping footpath overlay. Run ` +
        "scripts/fetch-footpaths-overpass.mjs to generate it; without it, " +
        "there's no way to visually tell whether a 'walking' route is " +
        "following real footpaths or just the road network.",
      err
    );
  }

  markersLayer = L.layerGroup().addTo(map); // Tier A: thumbnails
  dotCluster = L.markerClusterGroup({ showCoverageOnHover: false }).addTo(map); // Tier B: dots

  const profileSelect = document.getElementById("route-profile");
  if (profileSelect) {
    profileSelect.addEventListener("change", () => {
      routeProfile = profileSelect.value;
      if (selectedWaypoints.length > 1) plotRoute(selectedWaypoints);
    });
  }

  wireAppBadge();
  wireDarkMode();

  if (photos.length) {
    renderYearRangeSlider(photos); // builds the slider AND does the first renderMarkers() call
  } else {
    document.getElementById("timeline-controls").hidden = true;
  }

  renderCredits(photos);
}

/**
 * renderMarkers(photos) — entry point for "these are the photos in the
 * current year filter". Resets the reshuffle queue for this filter (per the
 * build plan: changing the year slider resets the shuffle so you can't land
 * on a stale batch that's no longer in range) and draws the first batch.
 * Both the initial load and every slider move funnel through here.
 */
function renderMarkers(photos) {
  currentFilteredPhotos = photos;
  // image_missing photos (no working file/thumb/web - see
  // scripts/fix-image-refs.mjs) have nothing to put in a 44x44 thumbnail
  // marker; picking them for Tier A just paints an empty #ccc grey square
  // (.photo-marker's fallback background, css/style.css). They still show
  // up as ordinary dots via currentFilteredPhotos, so they're not hidden,
  // just never given a thumbnail slot they can't fill.
  shuffleQueue = shuffledDiverse(photos.filter((p) => !p.image_missing));
  shuffleBatches = [];
  batchIndex = -1;
  drawNextBatch();
}

/**
 * drawNextBatch() — draws another random (diversity-interleaved) Tier-A
 * batch from the shuffle queue, or steps forward into a batch already drawn
 * this session if one exists ahead of the current position. If the queue
 * runs dry, it reshuffles the full filtered set rather than stopping, so
 * "next" always has something to show.
 */
function drawNextBatch() {
  if (batchIndex < shuffleBatches.length - 1) {
    batchIndex++;
  } else {
    if (!shuffleQueue.length && currentFilteredPhotos.length) {
      shuffleQueue = shuffledDiverse(currentFilteredPhotos);
    }
    shuffleBatches.push(shuffleQueue.splice(0, tierASize()));
    batchIndex = shuffleBatches.length - 1;
  }
  paintTiers(shuffleBatches[batchIndex] || []);
}

function drawPrevBatch() {
  if (batchIndex <= 0) return;
  batchIndex--;
  paintTiers(shuffleBatches[batchIndex] || []);
}

/**
 * paintTiers(tierAPhotos) — the single place that actually puts photo pins
 * on the map: Tier A (tierAPhotos) gets a real thumbnail marker, everything
 * else in currentFilteredPhotos gets a plain clustered dot. Both bind the
 * same popup and click handler - picking a location never depends on
 * having seen a thumbnail first.
 */
function paintTiers(tierAPhotos) {
  markersLayer.clearLayers();
  dotCluster.clearLayers();
  const tierAIds = new Set(tierAPhotos.map((p) => p.id));

  tierAPhotos.forEach((photo) => {
    if (typeof photo.lat !== "number" || typeof photo.lon !== "number") return;
    const marker = L.marker([photo.lat, photo.lon], { icon: photoMarkerIcon(photo) });
    bindPhotoMarker(marker, photo);
    marker.addTo(markersLayer);
  });

  currentFilteredPhotos.forEach((photo) => {
    if (tierAIds.has(photo.id)) return;
    if (typeof photo.lat !== "number" || typeof photo.lon !== "number") return;
    const dot = L.circleMarker([photo.lat, photo.lon], {
      radius: 5,
      weight: 1,
      color: "#8a3324",
      fillColor: "#8a3324",
      fillOpacity: 0.6,
    });
    bindPhotoMarker(dot, photo);
    dotCluster.addLayer(dot);
  });

  renderFilmstrip(tierAPhotos);
}

function bindPhotoMarker(marker, photo) {
  marker.bindPopup(`<strong>${buildingLabel(photo)}</strong><br>${photo.year ?? "?"}`);
  marker.on("click", () => onPhotoSelected(photo));
}

/**
 * renderFilmstrip(tierAPhotos) — prev/next strip bound to whichever photos
 * are currently Tier A. "Next" draws another shuffled batch (drawNextBatch);
 * "previous" just walks back through batches already drawn this session,
 * since there's no stable global order to page through otherwise.
 */
function renderFilmstrip(tierAPhotos) {
  const el = document.getElementById("filmstrip");
  if (!el) return;
  if (!tierAPhotos.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = "";

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "filmstrip-nav";
  prev.textContent = "‹";
  prev.disabled = batchIndex <= 0;
  prev.addEventListener("click", drawPrevBatch);
  el.appendChild(prev);

  const track = document.createElement("div");
  track.className = "filmstrip-track";
  tierAPhotos.forEach((photo) => {
    const fig = document.createElement("figure");
    fig.className = "filmstrip-item";
    const img = document.createElement("img");
    img.src = photo.thumb || photo.styled || photo.file;
    img.alt = "";
    const caption = document.createElement("figcaption");
    caption.textContent = photoDisplayName(photo);
    fig.appendChild(img);
    fig.appendChild(caption);
    fig.addEventListener("click", () => onPhotoSelected(photo));
    track.appendChild(fig);
  });
  el.appendChild(track);

  const next = document.createElement("button");
  next.type = "button";
  next.className = "filmstrip-nav";
  next.textContent = "›";
  next.addEventListener("click", drawNextBatch);
  el.appendChild(next);
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
  // Clamped, not just floored: any photo dated earlier than
  // TIMELINE_EARLIEST_YEAR still exists in the data (and still shows up if
  // nothing else filters it out), it's just outside what the slider itself
  // can scroll back to - the timeline's earliest handle position is 2001.
  const minYear = Math.max(TIMELINE_EARLIEST_YEAR, Math.min(...years));
  const maxYear = Math.max(minYear, Math.max(...years));
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

  // ---- Letting both handles land on the SAME year (a single-year
  // selection, not just a range) ----
  // minInput and maxInput are two full-width, same-size native thumbs
  // stacked in the same spot when lo === hi. With no z-index set, the one
  // later in the DOM (maxInput) always paints on top and eats every click
  // at that shared pixel - so once merged, minInput becomes permanently
  // unreachable by mouse/touch (it's still perfectly focusable by Tab,
  // since only its opacity is 0, but that's not how most people expect to
  // grab a slider handle). Bringing whichever thumb the user actually
  // presses to the front means a merged pair can be pulled apart again by
  // grabbing either one, not just whichever happened to be on top.
  minInput.addEventListener("pointerdown", () => {
    minInput.style.zIndex = "2";
    maxInput.style.zIndex = "1";
  });
  maxInput.addEventListener("pointerdown", () => {
    maxInput.style.zIndex = "2";
    minInput.style.zIndex = "1";
  });

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
    chip.textContent = `${i + 1}. ${photoDisplayName(photosById[wp.buildingId] || {})}`;
    el.appendChild(chip);
  });
  if (selectedWaypoints.length > 0) {
    const clear = document.createElement("button");
    clear.className = "btn-secondary";
    clear.textContent = "Clear path";
    clear.addEventListener("click", resetPath);
    el.appendChild(clear);
  }

  if (selectedWaypoints.length >= 2) {
    const comicBtn = document.createElement("button");
    comicBtn.id = "generate-comic-btn";
    comicBtn.textContent = "🖼️ Generate Comic";
    comicBtn.addEventListener("click", goToComicCreator);
    el.appendChild(comicBtn);
  }
}

/**
 * goToComicCreator() — hands the player's current path (in click order) off
 * to the standalone comic-creator page. The mapping UI and the comic UI are
 * deliberately separate pages/scripts (see docs) - this is the only bridge
 * between them, a small JSON blob of just the photos on this path, written
 * to localStorage (not the URL - photo objects carry full Commons metadata
 * and can be too big for a query string).
 */
function goToComicCreator() {
  const pathPhotos = selectedWaypoints
    .map((wp) => photosById[wp.buildingId])
    .filter(Boolean);
  if (pathPhotos.length < 2) return;
  try {
    localStorage.setItem("ccc_comic_path", JSON.stringify(pathPhotos));
  } catch (err) {
    console.warn("Could not stash path for the comic creator.", err);
  }
  window.location.href = "comic.html";
}

function resetPath() {
  selectedWaypoints = [];
  renderWaypointChips();
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  setRouteStatus("", "");
}

// Waits out whatever's left of a 1-request/second gap since the last OSRM
// fetch actually sent. See ROUTE_MIN_INTERVAL_MS above for why this exists.
async function throttleRouteRequest() {
  const wait = lastRouteRequestAt + ROUTE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRouteRequestAt = Date.now();
}

function drawFallbackRoute(waypoints) {
  if (routeLayer) map.removeLayer(routeLayer);
  // Deliberately styled differently from a real routed line (red, wider gaps)
  // so a degraded state is never visually mistaken for a normal one.
  routeLayer = L.polyline(waypoints.map((w) => [w.lat, w.lon]), { color: "#c0392b", weight: 3, dashArray: "2 8" });
  routeLayer.addTo(map);
}

function setRouteStatus(text, state) {
  const el = document.getElementById("route-status");
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state;
}

// bbox (with a buffer) around a route's coordinates, used only for the
// nearby-footpath heuristic in reportRouteStatus() - not for routing.
function bboxOfLineString(coords, bufferDeg) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon - bufferDeg, minLat - bufferDeg, maxLon + bufferDeg, maxLat + bufferDeg];
}

function anyFootpathNear([minLon, minLat, maxLon, maxLat]) {
  return footpathFeatures.some((f) => {
    const coords = f.geometry?.coordinates || [];
    return coords.some(([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat);
  });
}

/**
 * reportRouteStatus(route) — surfaces what OSRM returned instead of
 * discarding it. Distance/duration come from data plotRoute already fetches
 * (the route object, populated because of steps=true) but the old code threw
 * away. The "any footpaths nearby?" check is a heuristic, not a routing
 * input: it does not change what gets drawn, it only explains it. If a
 * "foot"-profile route has no dedicated footway/path/pedestrian ways
 * anywhere near it (see footpathFeatures, from data/paths.geojson - run
 * scripts/fetch-footpaths-overpass.mjs to generate it), that's almost always
 * why it looks identical to a driving route: OSM has nothing else to route
 * pedestrians onto in that area, not a bug in this code.
 */
function reportRouteStatus(route) {
  const km = (route.distance / 1000).toFixed(1);
  const mins = Math.max(1, Math.round(route.duration / 60));
  const profileLabel = { foot: "walking paths", bike: "cycling paths", driving: "roads" }[routeProfile] || routeProfile;

  if (routeProfile === "foot" && footpathFeatures.length === 0) {
    setRouteStatus(
      `${km} km, ~${mins} min via ${profileLabel}. No footpath data loaded yet ` +
        "(run scripts/fetch-footpaths-overpass.mjs) - can't confirm this avoids roads.",
      "no-footpaths"
    );
    return;
  }

  if (routeProfile === "foot" && !anyFootpathNear(bboxOfLineString(route.geometry.coordinates, NEARBY_PATH_BUFFER_DEG))) {
    setRouteStatus(
      `${km} km, ~${mins} min. No mapped campus footpaths near this route - it's likely following the road network.`,
      "no-footpaths"
    );
    return;
  }

  setRouteStatus(`${km} km, ~${mins} min via ${profileLabel}.`, "ok");
}

/**
 * plotRoute(waypoints) — OSRM's /route service accepts an arbitrary-length
 * semicolon-separated coordinate list and returns the fastest route visiting
 * them IN ORDER, split into one `legs[]` entry per consecutive pair. One
 * call handles A->B->C->... ; you do not need one call per pair.
 *
 * Throttled to respect the demo server's 1req/s limit (throttleRouteRequest)
 * and guarded with a sequence number so that if a newer plotRoute() call
 * starts before an older one's response comes back, the older one's result
 * is discarded instead of clobbering the map with a stale route.
 */
async function plotRoute(waypoints) {
  const seq = ++routeRequestSeq;
  await throttleRouteRequest();
  if (seq !== routeRequestSeq) return null; // superseded while waiting out the rate-limit gap

  const coords = waypoints.map((w) => `${w.lon},${w.lat}`).join(";");
  const endpoint = OSRM_ENDPOINTS[routeProfile] || OSRM_ENDPOINTS.foot;
  const url = `${endpoint}/${coords}?overview=full&geometries=geojson&steps=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM error ${res.status}`);
    const data = await res.json();
    if (seq !== routeRequestSeq) return null; // a newer request has since started

    // OSRM can return 200 OK with code !== "Ok" (e.g. "NoRoute" when a
    // waypoint snaps to a segment disconnected from the rest of the graph).
    // The old code only checked `!data.routes?.[0]`, which is true here too,
    // but it returned early with no fallback drawn at all - a silent no-op
    // that looks like a broken app, not a degraded one.
    const route = data.routes?.[0];
    if (data.code !== "Ok" || !route) {
      console.warn(`OSRM returned no usable route (code: ${data.code || "unknown"}) - drawing a straight line instead.`);
      drawFallbackRoute(waypoints);
      setRouteStatus("No route found between these points - showing a straight line instead.", "fallback");
      return null;
    }

    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(route.geometry, { style: { color: "#1a1a1a", weight: 3, dashArray: "4 4" } });
    routeLayer.addTo(map);

    reportRouteStatus(route);
    return route.legs; // one leg per consecutive waypoint pair
  } catch (err) {
    if (seq !== routeRequestSeq) return null;
    console.warn("OSRM route request failed - drawing straight lines instead.", err);
    drawFallbackRoute(waypoints);
    setRouteStatus("Couldn't reach the routing service - showing a straight line instead.", "fallback");
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
 * runStylizeAndStory(photo) — live-stylizes photo.web (falling back to
 * photo.file) via stylize.js's stylizePhoto() and caches the result onto
 * photo.styled, THEN calls jumpToBuilding(). story.js's renderPassage()
 * already reads `photo.styled || photo.web || photo.file` for the
 * background image, so updating photo.styled here is what "sets #story-bg's
 * image before invoking jumpToBuilding" in practice - story.js doesn't need
 * to know stylize.js exists, keeping the map/content separation clean. If
 * live stylization fails (no WebGL, image didn't load, etc.) photo.styled
 * is left alone and renderPassage() falls back to the precomputed/web/raw
 * image on its own.
 */
async function runStylizeAndStory(photo) {
  const src = photo.web || photo.file;
  if (src && typeof stylizePhoto === "function") {
    try {
      const img = await loadImage(src);
      const { canvas, ditherStyle } = stylizePhoto(img, {
        year: photo.year,
        lat: photo.lat,
        lon: photo.lon,
      });
      photo.styled = canvas.toDataURL("image/png");
      const wrap = document.getElementById("story-bg-wrap");
      // "halftone" is now baked into the canvas pixels by stylizePhoto()
      // itself (via glfx's colorHalftone) - the CSS dot overlay is ONLY
      // the fallback for when WebGL genuinely isn't available this
      // session (ditherStyle comes back "css-fallback" in that case, for
      // any originally requested style), so it no longer needs to be
      // toggled on for every "halftone" selection here.
      if (wrap) applyHalftoneCSS(wrap, ditherStyle === "css-fallback");
    } catch (err) {
      console.warn(`Live stylization failed for "${photo.id}" - using the precomputed/raw image instead.`, err);
    }
  }

  if (window.jumpToBuilding) {
    window.jumpToBuilding(photo.id);
  }
}

// attributionLine() now lives in js/shared.js (loaded before this file).


/**
 * renderCredits(photos) — auto-generates the attribution list from the
 * source/license/creator metadata already captured per photo at ingest
 * time. Don't discard those fields when curating photos.json - this is
 * where they're used, not just provenance bookkeeping. Renders both a
 * clickable list (source links to the actual Commons file page) and a
 * plain-text block the whole thing can be copy-pasted from in one go, for
 * anyone reusing these images/credits elsewhere.
 */
function renderCredits(photos) {
  const el = document.getElementById("credits-panel");
  if (!photos.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const items = photos
    .map((p) => {
      const label = p.building || buildingLabel(p);
      const creator = p.creator ? ` — photo by ${p.creator}` : "";
      return (
        `<li>${label}, ${p.year ?? "?"}${creator} — ${p.license ?? "license unknown"} — ` +
        `<a href="${p.source ?? "#"}" target="_blank" rel="noopener">Wikimedia Commons file page</a></li>`
      );
    })
    .join("");

  const plainText = photos.map(attributionLine).join("\n");

  el.innerHTML =
    `<summary>Credits (${photos.length})</summary><ul>${items}</ul>` +
    `<div class="attribution-copy-block">` +
    `<div class="attribution-copy-header"><span>Copy-pastable attribution</span>` +
    `<button type="button" id="copy-credits-btn">Copy</button></div>` +
    `<pre id="attribution-plaintext" tabindex="0"></pre>` +
    `</div>`;

  // textContent (not innerHTML) for the <pre> - it's plain attribution
  // text, not markup, and must round-trip exactly on copy/select-all.
  document.getElementById("attribution-plaintext").textContent = plainText;

  const copyBtn = document.getElementById("copy-credits-btn");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      copyBtn.textContent = "Copied!";
    } catch (err) {
      // Clipboard API can fail (permissions, insecure context) - the <pre>
      // is still plain selectable text, so select it as a fallback so the
      // user can Ctrl/Cmd+C manually instead of hitting a dead button.
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

// wireAppBadge() now lives in js/shared.js (shared with comic.html).

/**
 * wireDarkMode() — toggles a `data-theme="dark"` attribute on <html>; all
 * the actual color changes live in css/style.css under
 * `:root[data-theme="dark"]`. Persisted in localStorage so it survives a
 * reload; otherwise falls back to the OS-level prefers-color-scheme.
 */
function wireDarkMode() {
  const btn = document.getElementById("dark-mode-toggle");
  if (!btn) return;
  const stored = localStorage.getItem("ccc_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initialDark = stored ? stored === "dark" : prefersDark;
  applyTheme(initialDark);

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

document.addEventListener("DOMContentLoaded", init);
