#!/usr/bin/env node
/**
 * generate-photo-sizes.mjs — one-time/as-needed prep script, run LOCALLY
 * where the full-resolution originals in assets/photos/raw/ actually exist
 * (raw/ is gitignored — too big for the repo — so this can't run in CI or
 * on a fresh clone).
 *
 * Reads every image in assets/photos/raw/ and writes two compressed,
 * git-friendly copies of each:
 *
 *   assets/photos/thumbs/<name>.jpg   ~330px long edge  - map markers, gallery
 *   assets/photos/web/<name>.jpg      ~1400px long edge - stylization source,
 *                                                          story backgrounds,
 *                                                          comic panel export
 *
 * Both are committed to git; raw/ stays local-only.
 *
 * Usage:
 *   npm install sharp   # one-time
 *   node scripts/generate-photo-sizes.mjs
 *
 * After running, add a "web" field to each entry in data/photos.json
 * pointing at the new file (see data/photos.example.json), alongside the
 * existing "thumb" field. Re-run any time you add new raw originals or
 * want to regenerate at different sizes/quality.
 */

import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW_DIR = path.join(ROOT, "assets", "photos", "raw");
const THUMBS_DIR = path.join(ROOT, "assets", "photos", "thumbs");
const WEB_DIR = path.join(ROOT, "assets", "photos", "web");

const SIZES = [
  { dir: THUMBS_DIR, longEdge: 330, quality: 72 },
  { dir: WEB_DIR, longEdge: 1400, quality: 80 },
];

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

async function main() {
  let entries;
  try {
    entries = (await readdir(RAW_DIR)).filter((f) => IMAGE_EXT.test(f));
  } catch (err) {
    console.error(`Could not read ${RAW_DIR} - does it exist and have images in it?`);
    console.error(err.message);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.error(`No images found in ${RAW_DIR}. Nothing to do.`);
    process.exit(1);
  }

  for (const { dir } of SIZES) await mkdir(dir, { recursive: true });

  console.log(`Found ${entries.length} raw image(s). Generating ${SIZES.length} size tiers each...`);

  let ok = 0;
  let failed = 0;

  for (const file of entries) {
    const srcPath = path.join(RAW_DIR, file);
    const base = file.replace(IMAGE_EXT, "");
    for (const { dir, longEdge, quality } of SIZES) {
      const outPath = path.join(dir, `${base}.jpg`);
      try {
        await sharp(srcPath)
          .rotate() // respect EXIF orientation
          .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: true })
          .toFile(outPath);
      } catch (err) {
        console.warn(`  ✗ ${file} -> ${path.relative(ROOT, outPath)}: ${err.message}`);
        failed++;
        continue;
      }
    }
    ok++;
    console.log(`  ✓ ${file}`);
  }

  console.log(`\nDone: ${ok} processed, ${failed} failure(s).`);
  console.log(`Now add a "web" field to each data/photos.json entry pointing at`);
  console.log(`assets/photos/web/<name>.jpg (see data/photos.example.json), then commit`);
  console.log(`assets/photos/thumbs/ and assets/photos/web/ - never assets/photos/raw/.`);
}

main();
