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

const OVERPASS_API = "https://overpass-api.de/api/interpreter";

function parseArgs(argv) {
  // Same default box as fetch-buildings-overpass.mjs - narrow this to your
  // actual campus bounds before running for real, and keep it in sync with
  // whatever bbox you used for the buildings fetch.
  const out = { south: 37.266, west: -76.716, north: 37.276, east: -76.706, out: "./data/paths.geojson" };
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

  const res = await fetch(OVERPASS_API, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  });
  if (!res.ok) throw new Error(`Overpass error ${res.status}: ${await res.text()}`);

  const data = await res.json();
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
