#!/usr/bin/env node
/**
 * suggest-buildings-by-location.mjs — prep-day helper. Nearest-building
 * geo-matching, NOT a curation tool: it writes a `building_suggestion`
 * field (name + distance in meters) onto entries that have lat/lon, same
 * spirit as scripts/suggest-building-match.mjs's Gemini suggestions - a
 * human still confirms before anything is copied into the real
 * data/photos.json. Never touches the `building` field itself, and never
 * writes data/photos.json.
 *
 * Why this can't just auto-populate data/photos.json: nearest-building-by-
 * coordinate is wrong surprisingly often at this campus's density. Example
 * from this dataset - several genuine Colonial Williamsburg street-scene
 * photos (a silversmith shop, Duke of Gloucester Street) land within 15m
 * of the "Delta Gamma" sorority house point simply because that's the
 * closest *named* point in buildings.geojson in that area, not because the
 * photo has anything to do with Delta Gamma. Distance alone isn't enough
 * signal - hence "suggestion", not "answer".
 *
 * Usage:
 *   node scripts/suggest-buildings-by-location.mjs data/photos.scaffold.json
 *   node scripts/suggest-buildings-by-location.mjs data/photos.flickr.json
 *
 * Writes back to the same file with each lat/lon-bearing entry gaining:
 *   "building_suggestion": { "name": "Tucker Hall", "distance_m": 5.8 }
 * Entries without lat/lon are left untouched (no coordinate to match on -
 * those need a text/vision-based pass instead, e.g. the Gemini script).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIDENT_M = 12; // below this + a text hint, scripts/generate-photo-sizes.mjs's caller can consider it safe to promote

function centroid(geometry) {
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0][0];
  const lats = ring.map((c) => c[1]);
  const lons = ring.map((c) => c[0]);
  return [lats.reduce((a, b) => a + b, 0) / lats.length, lons.reduce((a, b) => a + b, 0) / lons.length];
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlmb = toRad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlmb / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/suggest-buildings-by-location.mjs <path-to-photos-file.json>");
    process.exit(1);
  }

  const buildingsRaw = JSON.parse(await readFile(path.join(ROOT, "data", "buildings.geojson"), "utf8"));
  const named = buildingsRaw.features
    .filter((f) => f.properties?.name)
    .map((f) => ({ name: f.properties.name, centroid: centroid(f.geometry) }));

  const targetPath = path.resolve(target);
  const photos = JSON.parse(await readFile(targetPath, "utf8"));

  let suggested = 0;
  let confident = 0;
  let skippedNoCoord = 0;

  for (const photo of photos) {
    if (photo.lat == null || photo.lon == null) {
      skippedNoCoord++;
      continue;
    }
    let best = null;
    for (const b of named) {
      const d = haversineM(photo.lat, photo.lon, b.centroid[0], b.centroid[1]);
      if (!best || d < best.distance_m) best = { name: b.name, distance_m: d };
    }
    if (best) {
      best.distance_m = Math.round(best.distance_m * 10) / 10;
      photo.building_suggestion = best;
      suggested++;
      if (best.distance_m <= CONFIDENT_M) confident++;
    }
  }

  await writeFile(targetPath, JSON.stringify(photos, null, 2) + "\n");
  console.log(`${target}: ${suggested} suggested (${confident} within ${CONFIDENT_M}m), ${skippedNoCoord} skipped (no lat/lon).`);
  console.log(`Still needs a human (or scripts/suggest-building-match.mjs's Gemini pass) to confirm before`);
  console.log(`copying entries into data/photos.json - see building_suggestion.distance_m, but also check`);
  console.log(`the title/description actually matches; nearest-point isn't always correct at this density.`);
}

main();
