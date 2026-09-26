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

const OVERPASS_API = "https://overpass-api.de/api/interpreter";

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

  const res = await fetch(OVERPASS_API, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  });
  if (!res.ok) throw new Error(`Overpass error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const geojson = overpassToGeoJSON(data);

  await writeFile(args.out, JSON.stringify(geojson, null, 2));
  console.log(`Wrote ${geojson.features.length} building footprints -> ${args.out}`);
  console.log("Hand-check names for anything null - relations/multipolygons were skipped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
