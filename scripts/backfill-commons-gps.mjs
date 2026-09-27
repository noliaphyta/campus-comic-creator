#!/usr/bin/env node
/**
 * backfill-commons-gps.mjs — pure data recovery, no network calls.
 *
 * 143 of the 183 entries in data/commons-geosearch-raw.json have no
 * `coordinates` entry (that field only reflects Commons' GeoData/Structured
 * Data index), so fetch-commons-images.mjs / download-wikimedia-photos.mjs
 * wrote them into data/photos.scaffold.json with `lat: null, lon: null,
 * needs_geolocation: true`. But the exact coordinate is still sitting on
 * each file's description page and already present in the same raw dump,
 * under imageinfo[0].extmetadata.GPSLatitude / GPSLongitude (source:
 * "commons-desc-page", from the page's {{Location}} template - these are
 * the 139 of them also tagged with the Commons maintenance category "Files
 * with coordinates missing SDC location of creation": the coordinate was
 * never promoted to a Structured Data statement, so GeoData-backed
 * endpoints skip it, even though it's right there on the page).
 *
 * This rejoins photos.scaffold.json (or photos.json) to the raw dump by id
 * (same slugified-title id used throughout this project) and fills lat/lon
 * from extmetadata wherever they're still null, clearing needs_geolocation
 * once both are set. Anything a human already hand-edited (a non-null lat
 * or lon) is left untouched - same preserve-if-set convention as
 * scripts/download-wikimedia-photos.mjs and
 * scripts/backfill-commons-source.mjs.
 *
 * Usage:
 *   node scripts/backfill-commons-gps.mjs data/photos.scaffold.json
 *   node scripts/backfill-commons-gps.mjs data/photos.json
 *   node scripts/backfill-commons-gps.mjs data/photos.json --dry-run
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function slugify(title) {
  return title
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// extmetadata GPS values are already plain decimal-degree strings (e.g.
// "37.270799", "-76.709155") - no DMS parsing needed, just validate + coerce.
function gpsFromRawEntry(page) {
  const em = page.imageinfo?.[0]?.extmetadata || {};
  const lat = Number.parseFloat(em.GPSLatitude?.value);
  const lon = Number.parseFloat(em.GPSLongitude?.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    console.error("Usage: node scripts/backfill-commons-gps.mjs <path-to-photos-file.json> [--dry-run]");
    process.exit(1);
  }

  const rawDump = JSON.parse(
    await readFile(path.join(ROOT, "data", "commons-geosearch-raw.json"), "utf8")
  );
  const gpsById = new Map();
  for (const page of rawDump) {
    const gps = gpsFromRawEntry(page);
    if (gps) gpsById.set(slugify(page.title), gps);
  }

  const targetPath = path.resolve(target);
  const photos = JSON.parse(await readFile(targetPath, "utf8"));

  let filled = 0;
  let alreadySet = 0;
  let noMatch = 0;
  for (const photo of photos) {
    const recovered = gpsById.get(photo.id);
    if (!recovered) {
      // e.g. a hand-added or Flickr-sourced entry not in the Commons dump,
      // or a raw entry whose extmetadata itself had no GPS at all -
      // nothing to recover, not an error.
      noMatch++;
      continue;
    }
    if (photo.lat != null || photo.lon != null) {
      alreadySet++; // don't clobber a hand-verified or already-backfilled value
      continue;
    }
    photo.lat = recovered.lat;
    photo.lon = recovered.lon;
    if (photo.needs_geolocation) photo.needs_geolocation = false;
    filled++;
  }

  console.log(
    `${target}: ${filled} entries backfilled with lat/lon from extmetadata GPS, ` +
      `${alreadySet} already had lat/lon (left untouched), ${noMatch} had no recoverable GPS in the raw dump.`
  );

  if (dryRun) {
    console.log("--dry-run: no file written.");
    return;
  }

  await writeFile(targetPath, JSON.stringify(photos, null, 2) + "\n");
  console.log(`${target}: written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
