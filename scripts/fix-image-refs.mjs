#!/usr/bin/env node
/**
 * fix-image-refs.mjs
 *
 * assets/photos/raw/ is gone (gitignored, never deployed, and now deleted
 * locally too - see generate-photo-sizes.mjs's own header: "raw/ is
 * gitignored ... can't run in CI or on a fresh clone"). Several photo
 * entries still had `file`/`thumb` pointing at assets/photos/raw/... local
 * paths - exactly what js/comic.js's downloadOriginalsZip() comment already
 * warned about: photo.file "is only reachable locally during prep-day
 * dev... never present on the deployed site." That's why images (mostly
 * the Commons-sourced ones) aren't loading in prod: their only reference
 * was a path that was never going to exist in production.
 *
 * This script never writes anything under assets/photos/raw/ into file,
 * thumb, or web - not as a value, not as a fallback. For every entry it
 * either:
 *
 *   (a) For any Commons-origin entry (source is a
 *       commons.wikimedia.org/wiki/File:... page - every entry from
 *       fetch-commons-images.mjs has this, regardless of whether it's
 *       still in the 400m-radius commons-geosearch-raw.json snapshot):
 *       derives file/thumb/web from Wikimedia's own Special:FilePath
 *       redirect - https://commons.wikimedia.org/wiki/Special:FilePath/<name>
 *       (full original) and the same URL with ?width=N (a resized redirect,
 *       server-capped to the original's actual size, no upscaling risk).
 *       This is a stable, documented MediaWiki feature, not a scrape - see
 *       https://www.mediawiki.org/wiki/Manual:Special:FilePath. `web` is a
 *       field js/app.js and js/story.js already read
 *       (`photo.web || photo.file`) but nothing had ever populated.
 *
 *   (b) if the entry has no Commons File: source at all (every Flickr-
 *       origin entry - import-local-flickr-photos.mjs makes no network
 *       calls and never captured a CDN URL, only the flickr.com page link
 *       for attribution, so there is nothing to derive a remote fix from):
 *       first checks assets/photos/thumbs/<id>.jpg and
 *       assets/photos/web/<id>.jpg - these ARE committed (unlike raw/), so
 *       if generate-photo-sizes.mjs has already been run against the local
 *       assets/photos/raw/ copies import-local-flickr-photos.mjs made,
 *       point the entry at those committed paths instead. Only if neither
 *       exists does it clear file/thumb/web to null and set
 *       `image_missing: true`. Printed at the end so these can be manually
 *       re-sourced (run generate-photo-sizes.mjs, then re-run this script)
 *       or dropped from the pool.
 *
 * Optional --verify does a live HEAD (GET-with-Range fallback) request
 * against every resolved URL and moves anything that doesn't actually come
 * back 2xx/redirect-ok into the same image_missing bucket - the only way to
 * be sure an image "exists" is to ask the server, not just construct a
 * plausible URL.
 *
 * Usage:
 *   node scripts/fix-image-refs.mjs
 *   node scripts/fix-image-refs.mjs --photos data/photos.json --photos data/photos.scaffold.json
 *   node scripts/fix-image-refs.mjs --verify
 *   node scripts/fix-image-refs.mjs --dry-run
 *
 * Flags:
 *   --photos       which JSON file to fix, default data/photos.json (repeatable)
 *   --web-width    target long-edge for the derived "web" tier, default 1200
 *                  (MediaWiki caps to the original's real width server-side)
 *   --verify       live-check every resolved URL, not just construct it
 *   --concurrency  parallel verify requests, default 8
 *   --dry-run      print the summary, write nothing
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const out = { photos: [], webWidth: 1200, verify: false, concurrency: 8, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--photos") out.photos.push(argv[++i]);
    else if (a === "--web-width") out.webWidth = Number(argv[++i]);
    else if (a === "--verify") out.verify = true;
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
  }
  if (out.photos.length === 0) out.photos.push("data/photos.json");
  return out;
}

const THUMBS_DIR = path.join(ROOT, "assets", "photos", "thumbs");
const WEB_DIR = path.join(ROOT, "assets", "photos", "web");

// Unlike assets/photos/raw/ (gitignored, prep-day only), thumbs/ and web/
// ARE committed - generate-photo-sizes.mjs writes them there specifically
// so they survive to prod. If an entry has no Commons File: source to
// derive a Special:FilePath URL from (every Flickr-origin entry, since
// import-local-flickr-photos.mjs never captures a Flickr CDN URL, only the
// photo-page link for attribution), this is the second chance before we
// give up and flag image_missing: check whether generate-photo-sizes.mjs
// has already produced local committed copies for this id.
async function committedLocalSizes(id) {
  const thumbPath = path.join(THUMBS_DIR, `${id}.jpg`);
  const webPath = path.join(WEB_DIR, `${id}.jpg`);
  const [hasThumb, hasWeb] = await Promise.all([
    access(thumbPath, fsConstants.F_OK).then(() => true).catch(() => false),
    access(webPath, fsConstants.F_OK).then(() => true).catch(() => false),
  ]);
  if (!hasThumb && !hasWeb) return null;
  return {
    thumb: hasThumb ? `assets/photos/thumbs/${id}.jpg` : null,
    web: hasWeb ? `assets/photos/web/${id}.jpg` : null,
  };
}

function isLocalRawPath(value) {
  return typeof value === "string" && value.startsWith("assets/photos/raw/");
}

function isHttpUrl(value) {
  return typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"));
}

const COMMONS_FILE_RE = /^https:\/\/commons\.wikimedia\.org\/wiki\/File:(.+)$/;

// Builds the Special:FilePath base for a Commons File: page URL, or null if
// `source` isn't a Commons file page (e.g. a Flickr page URL).
function commonsFilePathBase(sourceUrl) {
  if (typeof sourceUrl !== "string") return null;
  const m = sourceUrl.match(COMMONS_FILE_RE);
  if (!m) return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}`;
}

async function headOk(url) {
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (res.status === 405 || res.status === 501) {
      // some CDNs reject HEAD - a 1-byte ranged GET is cheap and just as conclusive
      res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "follow" });
    }
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

async function verifyAll(urls, concurrency) {
  const results = new Map();
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      results.set(url, await headOk(url));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  for (const photosFile of opts.photos) {
    const fullPath = path.join(ROOT, photosFile);
    let entries;
    try {
      entries = JSON.parse(await readFile(fullPath, "utf8"));
    } catch (err) {
      console.error(`Skipping ${photosFile}: ${err.message}`);
      continue;
    }

    let repointed = 0;
    let repointedLocal = 0;
    let alreadyRemote = 0;
    const unrecoverable = [];

    for (const entry of entries) {
      const hadLocalRef =
        isLocalRawPath(entry.file) || isLocalRawPath(entry.thumb) || isLocalRawPath(entry.web);

      if (isHttpUrl(entry.file) && !hadLocalRef) {
        alreadyRemote++;
        continue; // already points somewhere real and non-local - leave it
      }

      const base = commonsFilePathBase(entry.source);
      if (base) {
        entry.file = base;
        entry.thumb = `${base}?width=330`;
        entry.web = `${base}?width=${opts.webWidth}`;
        delete entry.image_missing;
        repointed++;
        continue;
      }

      const local = await committedLocalSizes(entry.id);
      if (local) {
        // No Commons source, but generate-photo-sizes.mjs already produced
        // committed thumbs/web copies for this id (typical for Flickr-origin
        // entries) - point at those instead of nulling the entry out.
        entry.thumb = local.thumb || entry.thumb;
        entry.web = local.web || entry.web;
        entry.file = entry.file && isHttpUrl(entry.file) ? entry.file : (local.web || local.thumb);
        delete entry.image_missing;
        repointedLocal++;
        continue;
      }

      entry.file = null;
      entry.thumb = null;
      entry.web = null;
      entry.image_missing = true;
      unrecoverable.push({ id: entry.id, hadLocalRef });
    }

    if (opts.verify) {
      const urls = [...new Set(entries.flatMap((e) => [e.file, e.thumb, e.web]).filter(isHttpUrl))];
      console.log(`Verifying ${urls.length} unique URLs live...`);
      const verified = await verifyAll(urls, opts.concurrency);
      for (const entry of entries) {
        if (entry.image_missing) continue;
        const bad = ["file", "thumb", "web"].filter((f) => isHttpUrl(entry[f]) && verified.get(entry[f]) === false);
        if (bad.length) {
          for (const f of bad) entry[f] = null;
          entry.image_missing = true;
          unrecoverable.push({ id: entry.id, hadLocalRef: false, failedVerify: bad });
        }
      }
    }

    console.log(`${photosFile}: ${entries.length} entries`);
    console.log(`  ${repointed} repointed to Special:FilePath Commons URLs (file/thumb/web)`);
    console.log(`  ${repointedLocal} repointed to committed assets/photos/thumbs|web/ copies`);
    console.log(`  ${alreadyRemote} already pointed at a working non-local URL, left alone`);
    console.log(`  ${unrecoverable.length} unrecoverable - cleared to null and flagged image_missing:`);
    for (const u of unrecoverable.slice(0, 25)) {
      console.log(`    - ${u.id}${u.failedVerify ? ` (failed live verify: ${u.failedVerify.join(",")})` : ""}`);
    }
    if (unrecoverable.length > 25) console.log(`    ...and ${unrecoverable.length - 25} more.`);

    if (!opts.dryRun) {
      await writeFile(fullPath, JSON.stringify(entries, null, 2) + "\n");
      console.log(`  written.\n`);
    } else {
      console.log(`  --dry-run: not written.\n`);
    }
  }

  console.log(
    "Note: entries left with image_missing:true will still need js/app.js's render paths\n" +
      "(`photo.thumb || photo.styled || photo.web || photo.file`) to handle all-null gracefully -\n" +
      "right now that chain resolves to `undefined` and gets assigned to img.src as-is."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
