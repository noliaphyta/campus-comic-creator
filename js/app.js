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

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

/**
 * photosToGeoJSON(photos) -> GeoJSON FeatureCollection
 * Leaflet.timeline needs a FeatureCollection with start/end (or a `time`)
 * property per feature - the flat photos.json array doesn't match that
 * shape on its own. This is the adapter step; don't skip it, it was the
 * one concrete bug risk flagged in the plan.
 */
function photosToGeoJSON(photos) {
  return {
    type: "FeatureCollection",
    features: photos
      .filter((p) => typeof p.lat === "number" && typeof p.lon === "number" && p.year)
      .map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: {
          ...p,
          start: `${p.year}-01-01`,
          end: `${p.year}-12-31`,
        },
      })),
  };
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

  if (photos.length && window.L.timeline) {
    const timeline = L.timeline(photosToGeoJSON(photos), {
      pointToLayer: (feature, latlng) => {
        const marker = L.marker(latlng);
        marker.bindPopup(
          `<strong>${feature.properties.building ?? "Unknown building"}</strong><br>${feature.properties.year ?? "?"}`
        );
        marker.on("click", () => onPhotoSelected(feature.properties));
        return marker;
      },
    });
    timeline.addTo(map);
    document.getElementById("timeline-controls").appendChild(timeline.getContainer());
  } else {
    // Fallback: plain markers, no year slider, if Leaflet.timeline didn't load
    // or there's no photo data yet.
    photos.forEach((photo) => {
      if (typeof photo.lat !== "number" || typeof photo.lon !== "number") return;
      const marker = L.marker([photo.lat, photo.lon]).addTo(map);
      marker.bindPopup(`<strong>${photo.building ?? "Unknown building"}</strong><br>${photo.year ?? "?"}`);
      marker.on("click", () => onPhotoSelected(photo));
    });
  }

  renderCredits(photos);
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

function runStylizeAndStory(photo) {
  const isLast = false; // TODO: app-level logic for "is this the last planned stop"
  // TODO: load photo.file into an <img>, call stylizePhoto() from stylize.js,
  // applyHalftoneCSS() or the dither branch depending on the active style
  // toggle, then show the result in #story-bg before calling jumpToBuilding.

  if (window.jumpToBuilding) {
    window.jumpToBuilding(photo.id);
  }
  if (isLast && window.renderEpilogue) {
    window.renderEpilogue();
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
