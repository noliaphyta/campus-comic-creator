#!/usr/bin/env node
/**
 * fetch-buildings-overpass.mjs
 *
 * ONE-TIME prep-day script. Pulls campus building footprints (name,
 * polygon, start_date where tagged) from OpenStreetMap via the public
 * Overpass API - this is a data-acquisition step, not a computer-vision
 * problem. Writes data/buildings.geojson directly; that's the file
 * js/app.js already reads and renders.
 *
 * Usage:
 *   node fetch-buildings-overpass.mjs --south 37.266 --west -76.716 --north 37.276 --east -76.706
 *
 * Get a bounding box quickly from https://boundingbox.klokantech.com or by
 * hand-drawing one on a map and reading the corner coordinates.
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
  // Rough default box around the W&M campus core - narrow this to your
  // actual campus bounds before running for real.
  const out = { south: 37.266, west: -76.716, north: 37.276, east: -76.706, out: "./data/buildings.geojson" };
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
      way["building"](${bbox});
      relation["building"](${bbox});
    );
    out body;
    >;
    out skel qt;
  `;
}

function overpassToGeoJSON(data) {
  // Minimal way->polygon conversion. Relations (multipolygons) are skipped
  // here for simplicity - hand-fix any campus building that's a relation
  // rather than a simple way, there are usually only one or two.
  const nodes = new Map();
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  const features = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.tags?.building) continue;
    const coords = el.nodes.map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 3) continue;

    features.push({
      type: "Feature",
      properties: {
        id: el.id,
        name: el.tags.name || el.tags["building:name"] || null,
        building: el.tags.building,
        start_date: el.tags.start_date || null,
      },
      geometry: { type: "Polygon", coordinates: [coords] },
    });
  }

  return { type: "FeatureCollection", features };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = buildQuery(args);

  console.log(`Querying Overpass for buildings in bbox ${args.south},${args.west},${args.north},${args.east}`);

  const data = await queryOverpass(query);
  const geojson = overpassToGeoJSON(data);

  await writeFile(args.out, JSON.stringify(geojson, null, 2));
  console.log(`Wrote ${geojson.features.length} building footprints -> ${args.out}`);
  console.log("Hand-check names for anything null - relations/multipolygons were skipped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
