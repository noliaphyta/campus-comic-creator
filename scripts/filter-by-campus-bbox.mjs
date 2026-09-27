#!/usr/bin/env node
/**
 * filter-by-campus-bbox.mjs — post-hoc geographic filter for a
 * photos.json-shaped file you already have (e.g. data/photos.flickr.json),
 * so you don't have to re-run scripts/import-local-flickr-photos.mjs from
 * the original local folder just to drop the off-campus stragglers.
 *
 * Drops any entry whose lat/lon falls outside the given bbox. Entries with
 * no usable GPS (needs_geolocation: true, or lat/lon null) are left alone -
 * there's nothing to check them against, and they already go through
 * manual placement.
 *
 * IMPORTANT LIMITATION: this only catches things that are geographically
 * far away (a gas station across town, an unrelated exhibit). It will NOT
 * separate Colonial Williamsburg (the historic district) from W&M's
 * Ancient Campus - the two are geographically adjacent/overlapping, so a
 * Colonial Williamsburg shop two blocks from the Wren Building passes this
 * filter fine. That distinction needs a title/description read, not
 * coordinates.
 *
 * Usage:
 *   node scripts/filter-by-campus-bbox.mjs data/photos.flickr.json
 *   node scripts/filter-by-campus-bbox.mjs data/photos.flickr.json --bbox 37.266,-76.716,37.276,-76.706
 *   node scripts/filter-by-campus-bbox.mjs data/photos.flickr.json --dry-run
 *
 * Overwrites the input file in place (after printing what it dropped),
 * unless --dry-run is passed.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BBOX = { south: 37.266, west: -76.716, north: 37.276, east: -76.706 };

function inBbox(lat, lon, bbox) {
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  const dryRun = args.includes("--dry-run");
  const bboxIdx = args.indexOf("--bbox");
  const bbox = bboxIdx >= 0
    ? (([south, west, north, east]) => ({ south, west, north, east }))(args[bboxIdx + 1].split(",").map(Number))
    : DEFAULT_BBOX;

  if (!target) {
    console.error("Usage: node scripts/filter-by-campus-bbox.mjs <path-to-photos-file.json> [--bbox s,w,n,e] [--dry-run]");
    process.exit(1);
  }

  const targetPath = path.resolve(target);
  const photos = JSON.parse(await readFile(targetPath, "utf8"));

  const kept = [];
  const dropped = [];
  for (const photo of photos) {
    if (photo.lat == null || photo.lon == null) {
      kept.push(photo); // no GPS to check - leave for manual placement, same as before
      continue;
    }
    if (inBbox(photo.lat, photo.lon, bbox)) kept.push(photo);
    else dropped.push(photo);
  }

  console.log(`${target}: ${photos.length} total -> ${kept.length} kept, ${dropped.length} dropped (outside ${JSON.stringify(bbox)})`);
  if (dropped.length) {
    console.log("\nDropped:");
    for (const p of dropped) console.log(`  - ${p.id} (${p.lat}, ${p.lon}) ${p.title || p.description || ""}`.slice(0, 100));
  }

  if (!dryRun) {
    await writeFile(targetPath, JSON.stringify(kept, null, 2) + "\n");
    console.log(`\nWrote ${kept.length} entries back to ${target}.`);
  } else {
    console.log("\nDry run - nothing written.");
  }
}

main();
