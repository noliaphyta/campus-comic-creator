#!/usr/bin/env node
/**
 * fetch-footpaths-overpass.mjs
 *
 * ONE-TIME prep-day script, sibling to fetch-buildings-overpass.mjs. Pulls
 * dedicated pedestrian ways (footway/path/pedestrian/steps/corridor, plus
 * sidewalks explicitly tagged foot=yes/designated) from OpenStreetMap via
 * the public Overpass API. Writes data/paths.geojson directly; js/app.js
 * renders it as a thin line layer distinct from the routed path.
 *
 * Why this script exists: OSRM's public "foot" profile will happily route
 * pedestrians along the vehicle road network when that's the only network
 * data available - it doesn't fail, it just produces a route that's
 * indistinguishable from a driving route. This script pulls the walking-only
 * ways separately so you can SEE, on the map, whether OSM actually has
 * dedicated campus footpaths near the buildings you care about. If this
 * layer comes back empty (or sparse) around a stretch of a plotted route,
 * that's the real explanation for a "foot" route that looks like it's
 * following roads: it's not a routing bug, it's a missing-data problem, and
 * the fix is mapping the paths in OSM (or campus GIS), not changing code.
 *
 * Usage:
 *   node fetch-footpaths-overpass.mjs --south 37.266 --west -76.716 --north 37.276 --east -76.706
 *
 * Use the SAME bbox you used (or will use) for fetch-buildings-overpass.mjs.
 */

import { writeFile } from "node:fs/promises";

// overpass-api.de is a single shared public instance and is frequently
// overloaded (504 / "Dispatcher_Client::request_read_and_idx::timeout" is
// Overpass's own "I'm too busy right now" response, not an error in the
// query). These are the other public mirrors documented at
// https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
// - queryOverpass() below retries each with backoff before giving up.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Overpass's Apache front-end now 406s any request that doesn't send a
// distinct, descriptive User-Agent (Node's fetch sends none by default) -
// see https://community.openstreetmap.org/t/overpass-api-error-406/143198.
// Put a real contact here before running this for real, same as the
// Wikimedia Commons script's USER_AGENT.
const USER_AGENT =
  "campus-comic-creator/1.0 (hackathon project; contact: eychan@wm.edu";

/**
 * queryOverpass(query) — POSTs to each endpoint in OVERPASS_ENDPOINTS in
 * turn, retrying a busy/overloaded response (429/502/503/504) a few times
 * with backoff before moving to the next mirror. Only gives up once every
 * endpoint has been tried; a real query error (4xx other than 429, or a
 * malformed-query message in the body) still fails fast instead of retrying
 * pointlessly against every mirror.
 */
async function queryOverpass(query) {
  const RETRYABLE = new Set([429, 502, 503, 504]);
  let lastErr;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
          body: query,
        });

        if (res.ok) return await res.json();

        if (RETRYABLE.has(res.status)) {
          lastErr = new Error(`Overpass error ${res.status} from ${endpoint}`);
          const waitMs = attempt * 3000;
          console.warn(`${endpoint} is busy (${res.status}) - retrying in ${waitMs / 1000}s (attempt ${attempt}/3)...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        // Not a "busy" status - a real error (bad query, auth, etc). No
        // point retrying this or trying other mirrors, they'll say the same.
        throw new Error(`Overpass error ${res.status}: ${await res.text()}`);
      } catch (err) {
        lastErr = err;
        if (err.name === "TypeError") {
          // Network-level failure (DNS, connection refused, etc) - worth a
          // quick retry, but don't loop forever on a dead mirror.
          console.warn(`${endpoint} unreachable (${err.message}) - retrying (attempt ${attempt}/3)...`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }
        throw err;
      }
    }
    console.warn(`Giving up on ${endpoint} after 3 attempts, trying the next mirror...`);
  }

  throw lastErr || new Error("All Overpass endpoints failed");
}

function parseArgs(argv) {
  // Same default box as fetch-buildings-overpass.mjs - narrow this to your
  // actual campus bounds before running for real, and keep it in sync with
  // whatever bbox you used for the buildings fetch.
  const out = { south: 37.258, west: -76.7383, north: 37.284, east: -76.6986, out: "./data/paths.geojson" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    const val = argv[i + 1];
    if (key === "out") out.out = val;
    else if (key in out) out[key] = Number(val);
  }
  return out;
}

function buildQuery({ south, west, north, east }) {
  const bbox = `${south},${west},${north},${east}`;
  return `
    [out:json][timeout:25];
    (
      way["highway"~"^(footway|path|pedestrian|steps|corridor)$"](${bbox});
      way["highway"]["sidewalk"~"^(yes|both|left|right)$"](${bbox});
      way["highway"]["foot"~"^(yes|designated)$"](${bbox});
    );
    out body;
    >;
    out skel qt;
  `;
}

function overpassToGeoJSON(data) {
  const nodes = new Map();
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  const features = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.tags?.highway) continue;
    const coords = el.nodes.map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 2) continue;

    features.push({
      type: "Feature",
      properties: {
        id: el.id,
        highway: el.tags.highway,
        name: el.tags.name || null,
        surface: el.tags.surface || null,
      },
      geometry: { type: "LineString", coordinates: coords },
    });
  }

  return { type: "FeatureCollection", features };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = buildQuery(args);

  console.log(`Querying Overpass for dedicated footpaths in bbox ${args.south},${args.west},${args.north},${args.east}`);

  const data = await queryOverpass(query);
  const geojson = overpassToGeoJSON(data);

  await writeFile(args.out, JSON.stringify(geojson, null, 2));
  console.log(`Wrote ${geojson.features.length} footpath ways -> ${args.out}`);
  if (geojson.features.length === 0) {
    console.log(
      "Zero results: OSM has no dedicated pedestrian ways mapped in this bbox yet. " +
        "Expect the 'foot' OSRM profile to route along roads here until someone maps them."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
