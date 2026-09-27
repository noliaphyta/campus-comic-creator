#!/usr/bin/env node
/**
 * quarantine-library-exhibits.mjs
 *
 * Companion to data/review/library-exhibit-cases.json (235 entries pulled
 * out of data/photos.json - see that file's header: every "Case N of ..."
 * / "Label from Case N of ..." photo from Swem Library's Special
 * Collections exhibit cases, all sitting at one of just 2 GPS points
 * (Read & Relax area / 3rd Floor Rotunda Gallery), across 8 different
 * exhibits from 2012-2013. These are display-case photos, not distinct
 * campus locations, so they were removed from the live map pool pending
 * manual review.
 *
 * This script only MOVES local image files that already exist on disk
 * (raw/thumbs/web, wherever you're running it from - typically wherever
 * import-local-flickr-photos.mjs or generate-photo-sizes.mjs put them) into
 * assets/photos/review/library-exhibits/<tier>/, so you can flip through
 * them in Finder/Explorer without them being mixed in with the active pool.
 * It does NOT touch data/photos.json (already updated) or delete anything -
 * only moves files that exist; anything not found locally is just skipped
 * and reported, not an error.
 *
 * Usage:
 *   node scripts/quarantine-library-exhibits.mjs --dry-run
 *   node scripts/quarantine-library-exhibits.mjs
 *
 * After reviewing assets/photos/review/library-exhibits/, keepers go back
 * into data/photos.json by hand (or write a --restore-ids id1,id2,... pass
 * if you want that scripted too) and everything else can just be deleted.
 */

import { readFile, mkdir, rename, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST = path.join(ROOT, "data", "review", "library-exhibit-cases.json");
const TIERS = [
  { name: "raw", dir: path.join(ROOT, "assets", "photos", "raw") },
  { name: "thumbs", dir: path.join(ROOT, "assets", "photos", "thumbs") },
  { name: "web", dir: path.join(ROOT, "assets", "photos", "web") },
];
const DEST_ROOT = path.join(ROOT, "assets", "photos", "review", "library-exhibits");

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const entries = JSON.parse(await readFile(MANIFEST, "utf8"));
  console.log(`${entries.length} entries in manifest.`);

  let moved = 0;
  let skipped = 0;

  for (const { name, dir } of TIERS) {
    const destDir = path.join(DEST_ROOT, name);
    if (!dryRun) await mkdir(destDir, { recursive: true });

    for (const entry of entries) {
      const srcPath = path.join(dir, `${entry.id}.jpg`);
      if (!(await exists(srcPath))) {
        skipped++;
        continue;
      }
      const destPath = path.join(destDir, `${entry.id}.jpg`);
      console.log(`  ${dryRun ? "[dry-run] would move" : "moving"}: ${name}/${entry.id}.jpg`);
      if (!dryRun) await rename(srcPath, destPath);
      moved++;
    }
  }

  console.log(`\n${moved} file(s) ${dryRun ? "would be moved" : "moved"} into ${DEST_ROOT}`);
  console.log(`${skipped} not found locally (expected if raw/ isn't on this machine, or images were never downloaded for these ids) - skipped, not an error.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
