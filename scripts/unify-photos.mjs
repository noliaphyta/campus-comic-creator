#!/usr/bin/env node
/**
 * unify-photos.mjs — pure data merge, no network calls.
 *
 * Combines the three photo pools into one and writes the result to
 * data/photos.json (the file js/app.js loads by default - see
 * `photosPath` in js/app.js). After this, the site has the full pool
 * instead of the previous 8-12-photo curated subset:
 *
 *   - data/photos.json           10 entries  (hand-curated so far, some
 *                                             fields hand-edited/localized)
 *   - data/photos.scaffold.json  183 entries (Commons candidates)
 *   - data/photos.flickr.json    457 entries (Flickr candidates)
 *
 * Priority on id collisions: photos.json > scaffold > flickr. 9 of the
 * current 10 curated entries also exist in the scaffold (pre-localization,
 * pointing at remote upload.wikimedia.org URLs); the curated version wins
 * so the already-downloaded local assets/photos/... paths aren't
 * overwritten with stale remote ones. flickr.json's ids (`flickr_<id>`)
 * don't collide with either.
 *
 * Does NOT download any images. It only merges the JSON records - entries
 * pulled in from scaffold/flickr still point at assets/photos/raw/... paths
 * that won't exist on disk until the corresponding download step
 * (scripts/download-wikimedia-photos.mjs for Commons entries,
 * scripts/import-local-flickr-photos.mjs for Flickr entries,
 * scripts/generate-photo-sizes.mjs for thumbs) has actually been run for
 * them. This script prints how many merged entries still need that so
 * nothing is silently broken.
 *
 * Backs up the current data/photos.json to data/photos.pre-unify.bak.json
 * before overwriting (does not touch the existing, separate
 * data/photos.json.bak.json).
 *
 * Usage:
 *   node scripts/unify-photos.mjs
 *   node scripts/unify-photos.mjs --dry-run
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");

async function loadJSON(rel) {
  try {
    return JSON.parse(await readFile(path.join(DATA, rel), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const curated = await loadJSON("photos.json");
  const scaffold = await loadJSON("photos.scaffold.json");
  const flickr = await loadJSON("photos.flickr.json");

  // Lowest priority first, so later Map.set() calls (higher priority) win.
  const byId = new Map();
  for (const p of flickr) byId.set(p.id, p);
  for (const p of scaffold) byId.set(p.id, p);
  for (const p of curated) byId.set(p.id, p);

  const unified = [...byId.values()];

  const missingLocalFile = unified.filter(
    (p) => typeof p.file === "string" && p.file.startsWith("assets/photos/raw/")
  );
  const missingThumb = unified.filter((p) => !p.thumb);
  const noDerivatives = unified.filter((p) => p.derivativesAllowed === false);
  const stillNeedsGeo = unified.filter(
    (p) => p.needs_geolocation || typeof p.lat !== "number" || typeof p.lon !== "number"
  );

  console.log(`Merged: ${curated.length} curated + ${scaffold.length} scaffold + ${flickr.length} flickr`);
  console.log(`  -> ${unified.length} unique entries (${curated.length + scaffold.length + flickr.length - unified.length} collisions resolved by priority)`);
  console.log(`  ${missingLocalFile.length} entries reference a local assets/photos/raw/ path - run the download scripts for any not already fetched`);
  console.log(`  ${missingThumb.length} entries have no thumb - run scripts/generate-photo-sizes.mjs after downloading`);
  console.log(`  ${noDerivatives.length} entries are licensed with derivatives NOT allowed - the stylize.js pipeline produces a derivative work, so these need a license re-check before running through it`);
  console.log(`  ${stillNeedsGeo.length} entries still lack usable lat/lon and won't render as map pins`);

  if (dryRun) {
    console.log("--dry-run: no file written.");
    return;
  }

  await writeFile(
    path.join(DATA, "photos.pre-unify.bak.json"),
    JSON.stringify(curated, null, 2) + "\n"
  );
  await writeFile(path.join(DATA, "photos.json"), JSON.stringify(unified, null, 2) + "\n");
  console.log(`data/photos.json: written (${unified.length} entries). Previous curated set backed up to data/photos.pre-unify.bak.json.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
