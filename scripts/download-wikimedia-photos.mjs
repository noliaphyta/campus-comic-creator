#!/usr/bin/env node
/**
 * download-wikimedia-photos.mjs
 *
 * ONE-TIME prep-day script. Localizes remote Wikimedia Commons image URLs
 * into assets/photos/raw/ + assets/photos/thumbs/, and normalizes whatever
 * shape the input JSON is in into the project's canonical photo-entry
 * schema (see data/photos.example.json).
 *
 * Accepts THREE input shapes, auto-detected per entry:
 *   1. Raw geosearch dump  - data/commons-geosearch-raw.json (183 entries -
 *      every file the Commons API found in-radius, most WITHOUT a
 *      `coordinates` prop; see note below).
 *   2. Scaffold shape      - data/photos.scaffold.json (id/file/thumb/
 *      building/lat/lon/... - what fetch-commons-images.mjs writes today).
 *   3. Curated shape       - data/photos.json (same shape as #2, already
 *      hand-reviewed).
 *
 * Why this exists / the "183 vs 40" gap: fetch-commons-images.mjs's
 * toScaffoldEntry() previously *dropped* any candidate lacking a
 * `coordinates` entry, which cut the original 183 Commons geosearch
 * results down to the 40 that happened to carry one. The other 143 are
 * real, valid Commons files (imageinfo, license, dimensions all present) -
 * they just don't have a `{{Location}}`-style coordinate on the file page
 * itself, only a geosearch-radius match. This script keeps all of them:
 * anything missing lat/lon gets `lat: null, lon: null,
 * needs_geolocation: true` instead of being silently discarded, so you can
 * still hand-place them against a building later (matching the "read the
 * description, match the nearest building by hand" step already in the
 * build plan) instead of losing 143 candidates to a filter nobody chose on
 * purpose.
 *
 * Merging: if --out already exists, entries are merged by id rather than
 * overwritten - any hand-curated field on an existing entry (building,
 * lat, lon, year, needs_geolocation) is PRESERVED if it's already
 * non-null, even if the fresh normalize pass would produce a different
 * value. file/thumb are always updated to the local path once downloaded.
 * This makes it safe to re-run against the raw 183-file dump after you've
 * already hand-curated some of the 40 without losing that work.
 *
 * Usage:
 *   node scripts/download-wikimedia-photos.mjs --dry-run
 *   node scripts/download-wikimedia-photos.mjs \
 *     --in data/commons-geosearch-raw.json --out data/photos.scaffold.json
 *   node scripts/download-wikimedia-photos.mjs   # defaults: data/photos.json in place
 *
 * Flags:
 *   --in         input file (default: data/photos.json)
 *   --out        output file (default: same as --in, EXCEPT when --in looks
 *                like the raw geosearch dump, in which case it defaults to
 *                data/photos.scaffold.json so the raw archival file is
 *                never overwritten)
 *   --raw-dir       default assets/photos/raw
 *   --thumb-dir     default assets/photos/thumbs
 *   --force         re-download/overwrite existing local files
 *   --dry-run       preview only, touches no files
 *   --rate-limit-ms delay between entries in ms (default 1500). Raise this
 *                    further if you still see 429s - upload.wikimedia.org
 *                    and thumb.wikimedia.org are CDN media servers with
 *                    their own throttling, separate from and stricter than
 *                    the api.php endpoint fetch-commons-images.mjs talks to.
 *                    429/503 responses are automatically retried with
 *                    exponential backoff (respecting a Retry-After header
 *                    when the server sends one) up to 5 attempts before
 *                    that entry is logged as a failure - a failure doesn't
 *                    stop the run, and re-running the script later only
 *                    retries what didn't already succeed (already-downloaded
 *                    files are skipped).
 *
 * Does NOT resize/recompress (no image-processing dependency added on
 * purpose). Flags anything under the project's 1500px long-edge bar using
 * width/height metadata that's already present.
 */

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const USER_AGENT =
  "campus-comic-creator/1.0 (hackathon project; contact: eychan@wm.edu)";

const RATE_LIMIT_MS = 1500; // between entries - was 500ms, too aggressive for upload.wikimedia.org/thumb.wikimedia.org (CDN media servers, not the api.php endpoint fetch-commons-images.mjs was tuned for; they throttle harder and 429 sooner)
const INTRA_ENTRY_DELAY_MS = 400; // between an entry's raw fetch and its thumb fetch - these used to fire back-to-back with no delay at all
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 2000;
const MIN_LONG_EDGE = 1500;

// Fields where an existing --out entry's non-null value wins over a fresh
// normalize pass - these are the ones a human might have hand-edited.
const PRESERVE_IF_SET = ["building", "lat", "lon", "year", "needs_geolocation"];

function parseArgs(argv) {
  const out = {
    in: "./data/photos.json",
    out: null,
    rawDir: "./assets/photos/raw",
    thumbDir: "./assets/photos/thumbs",
    force: false,
    dryRun: false,
    rateLimitMs: RATE_LIMIT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in") out.in = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--raw-dir") out.rawDir = argv[++i];
    else if (arg === "--thumb-dir") out.thumbDir = argv[++i];
    else if (arg === "--force") out.force = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--rate-limit-ms") out.rateLimitMs = Number(argv[++i]);
  }
  if (!out.rateLimitMs) out.rateLimitMs = RATE_LIMIT_MS;
  if (!out.out) {
    out.out = /commons-geosearch-raw/.test(out.in)
      ? "./data/photos.scaffold.json"
      : out.in;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isRemote(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function extFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return (match ? match[1] : "jpg").toLowerCase();
  } catch {
    return "jpg";
  }
}

function slugify(title) {
  return title
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function plainText(value = "") {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function firstHref(value = "") {
  const match = value.match(/href=["']([^"']+)["']/i);
  if (!match) return null;
  return match[1].startsWith("//") ? `https:${match[1]}` : match[1];
}

function guessYear(extmetadata = {}) {
  const raw = extmetadata?.DateTimeOriginal?.value || extmetadata?.DateTime?.value || "";
  const match = raw.match(/\b(1[5-9]\d\d|20\d\d)\b/);
  return match ? Number(match[0]) : null;
}

// Raw geosearch entries look like { title, pageid, coordinates?, imageinfo: [...] }.
// Scaffold/curated entries look like { id, file, thumb, building, lat, lon, ... }.
function isRawShape(entry) {
  return Array.isArray(entry.imageinfo);
}

function normalizeRawEntry(page) {
  const info = page.imageinfo?.[0];
  if (!info) return null; // shouldn't happen (checked before this runs), guard anyway

  const coord = page.coordinates?.[0];
  const metadata = info.extmetadata || {};
  const rawArtist = metadata.Artist?.value || "";
  const rawCredit = metadata.Credit?.value || "";
  const license =
    metadata.LicenseShortName?.value ||
    metadata.UsageTerms?.value ||
    "UNKNOWN - verify on file page";

  return {
    id: slugify(page.title),
    file: info.url,
    thumb: info.thumburl || null,
    year: guessYear(info.extmetadata),
    building: null,
    lat: coord ? coord.lat : null,
    lon: coord ? coord.lon : null,
    needs_geolocation: !coord,
    source: page.descriptionurl || null,
    license,
    licenseUrl: metadata.LicenseUrl?.value || null,
    creator: plainText(rawArtist || rawCredit) || null,
    creatorUrl: firstHref(rawArtist) || firstHref(rawCredit) || null,
    credit: plainText(rawCredit) || null,
    description: plainText(metadata.ImageDescription?.value || "") || null,
    dateOriginal: metadata.DateTimeOriginal?.value || metadata.DateTime?.value || null,
    width: info.width || null,
    height: info.height || null,
  };
}

// Parses a Retry-After header, which per spec is EITHER a number of
// seconds OR an HTTP-date - handle both rather than assuming seconds.
function parseRetryAfterMs(header) {
  if (!header) return null;
  const asSeconds = Number(header);
  if (!Number.isNaN(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

async function downloadTo(url, destPath, { force, dryRun }) {
  if (!force && (await exists(destPath))) return { status: "skipped-exists" };
  if (dryRun) return { status: "would-download" };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(destPath, buf);
      return { status: "downloaded", bytes: buf.length };
    }

    // 429 (rate limited) and 503 (upstream overloaded, common on the media
    // CDN under load) are worth backing off and retrying; anything else
    // (404, etc.) is a real error - fail immediately, don't waste retries.
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const backoffMs = retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * 500);
      console.warn(
        `    HTTP ${res.status} on attempt ${attempt + 1}/${MAX_RETRIES + 1}, waiting ${
          backoffMs + jitterMs
        }ms before retry: ${url}`
      );
      await sleep(backoffMs + jitterMs);
      continue;
    }

    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  throw new Error(`HTTP 429/503 fetching ${url} - exhausted ${MAX_RETRIES} retries`);
}

function toRepoRelative(dir, filename) {
  return path.join(dir, filename).replace(/\\/g, "/");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Reading ${opts.in}`);
  const inputRaw = JSON.parse(await readFile(opts.in, "utf-8"));
  if (!Array.isArray(inputRaw)) {
    throw new Error(`${opts.in} must be a JSON array of photo entries.`);
  }

  const normalized = inputRaw
    .map((entry) => (isRawShape(entry) ? normalizeRawEntry(entry) : entry))
    .filter(Boolean);

  const skippedNoImageUrl = normalized.filter((e) => !e.file).length;
  console.log(
    `${inputRaw.length} input entries -> ${normalized.length} normalized` +
      (skippedNoImageUrl ? ` (${skippedNoImageUrl} had no usable image URL, skipped)` : "")
  );

  // Merge with an existing --out file so hand-curated fields survive a re-run.
  let merged = normalized;
  if (opts.out !== opts.in && (await exists(opts.out))) {
    const existing = JSON.parse(await readFile(opts.out, "utf-8"));
    const existingById = new Map(existing.map((e) => [e.id, e]));
    merged = normalized.map((fresh) => {
      const prior = existingById.get(fresh.id);
      if (!prior) return fresh;
      const combined = { ...fresh };
      for (const field of PRESERVE_IF_SET) {
        if (prior[field] !== null && prior[field] !== undefined) combined[field] = prior[field];
      }
      return combined;
    });
    // Keep any existing entries the fresh pull no longer contains (e.g. a
    // hand-added Flickr entry sitting in the same scaffold file already).
    const freshIds = new Set(normalized.map((e) => e.id));
    for (const old of existing) {
      if (!freshIds.has(old.id)) merged.push(old);
    }
    console.log(`Merged with existing ${opts.out} (${existing.length} prior entries).`);
  }

  if (!opts.dryRun) {
    await mkdir(opts.rawDir, { recursive: true });
    await mkdir(opts.thumbDir, { recursive: true });
    if (opts.out === opts.in) {
      const backupPath = `${opts.in}.bak.json`;
      if (!(await exists(backupPath))) {
        await writeFile(backupPath, JSON.stringify(inputRaw, null, 2));
        console.log(`Backed up original to ${backupPath} (only written once).`);
      }
    }
  }

  const flaggedForResolution = [];
  const flaggedForGeolocation = [];
  const failures = [];
  let downloadedCount = 0;
  let skippedCount = 0;

  for (const entry of merged) {
    if (!isRemote(entry.file)) continue; // already local

    const rawExt = extFromUrl(entry.file);
    const rawDest = path.join(opts.rawDir, `${entry.id}.${rawExt}`);
    const rawRelPath = toRepoRelative(opts.rawDir, `${entry.id}.${rawExt}`);
    let madeNetworkRequest = false; // only sleep for entries that actually hit the network

    try {
      const result = await downloadTo(entry.file, rawDest, opts);
      if (result.status === "downloaded") {
        downloadedCount++;
        madeNetworkRequest = true;
        console.log(`  [raw] ${entry.id} -> ${rawDest} (${result.bytes} bytes)`);
      } else if (result.status === "skipped-exists") {
        skippedCount++;
        console.log(`  [raw] ${entry.id} already exists, skipping (use --force to redo)`);
      } else {
        console.log(`  [raw] ${entry.id} would download from ${entry.file}`);
      }
      entry.file = rawRelPath;
    } catch (err) {
      console.warn(`  [raw] FAILED ${entry.id}: ${err.message}`);
      failures.push({ id: entry.id, field: "file", error: err.message });
      continue; // a failed raw fetch already went through retries/backoff - no extra sleep needed before the next entry
    }

    if (isRemote(entry.thumb)) {
      const thumbExt = extFromUrl(entry.thumb);
      const thumbDest = path.join(opts.thumbDir, `${entry.id}.${thumbExt}`);
      const thumbRelPath = toRepoRelative(opts.thumbDir, `${entry.id}.${thumbExt}`);
      const thumbWillFetch = opts.force || !(await exists(thumbDest));
      // Only pace ourselves before the thumb request if the raw request
      // just now actually hit the network AND the thumb is also about to -
      // if either side is a no-op (already on disk, or dry-run), there's no
      // real request to space out from.
      if (madeNetworkRequest && thumbWillFetch && !opts.dryRun) {
        await sleep(INTRA_ENTRY_DELAY_MS);
      }
      try {
        const result = await downloadTo(entry.thumb, thumbDest, opts);
        if (result.status === "downloaded") {
          console.log(`  [thumb] ${entry.id} -> ${thumbDest}`);
          madeNetworkRequest = true;
        } else if (result.status === "skipped-exists") {
          console.log(`  [thumb] ${entry.id} already exists, skipping`);
        }
        entry.thumb = thumbRelPath;
      } catch (err) {
        console.warn(`  [thumb] FAILED ${entry.id}, dropping thumb field: ${err.message}`);
        failures.push({ id: entry.id, field: "thumb", error: err.message });
        entry.thumb = null;
        madeNetworkRequest = true; // the attempt itself (with its own retries) hit the network even though it ultimately failed
      }
    }

    const longEdge = Math.max(entry.width || 0, entry.height || 0);
    if (longEdge && longEdge < MIN_LONG_EDGE) flaggedForResolution.push({ id: entry.id, longEdge });
    if (entry.needs_geolocation || entry.lat == null || entry.lon == null) {
      flaggedForGeolocation.push(entry.id);
    }

    // A fully-cached entry (both raw and thumb already on disk) makes zero
    // requests, so there's nothing to rate-limit against - skip the sleep
    // entirely rather than paying opts.rateLimitMs for a no-op. Same for
    // --dry-run, which never makes a real request either way.
    if (madeNetworkRequest && !opts.dryRun) {
      await sleep(opts.rateLimitMs);
    }
  }

  if (!opts.dryRun) {
    await writeFile(opts.out, JSON.stringify(merged, null, 2));
    console.log(`\nWrote ${merged.length} entries to ${opts.out}.`);
  } else {
    console.log(`\nDry run - no files were written.`);
  }

  console.log(`\nDone. ${downloadedCount} downloaded, ${skippedCount} already present.`);

  if (flaggedForGeolocation.length) {
    console.log(
      `\n${flaggedForGeolocation.length} entr${flaggedForGeolocation.length === 1 ? "y needs" : "ies need"} manual building/lat-lon assignment (Step 3 of the build plan):`
    );
    for (const id of flaggedForGeolocation) console.log(`  - ${id}`);
  }
  if (flaggedForResolution.length) {
    console.log(`\n${flaggedForResolution.length} entr${flaggedForResolution.length === 1 ? "y" : "ies"} below the ${MIN_LONG_EDGE}px long-edge bar:`);
    for (const f of flaggedForResolution) console.log(`  - ${f.id} (long edge ${f.longEdge}px)`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f.id} [${f.field}]: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
