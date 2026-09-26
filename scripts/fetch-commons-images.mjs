#!/usr/bin/env node
/**
 * fetch-commons-images.mjs
 *
 * ONE-TIME prep-day script. Run this by hand once (maybe twice, if you do a
 * "refresh" pass after a community-upload round). It is NOT called from the
 * deployed site and should never run during the hackathon or in the browser.
 *
 * Hits Wikimedia's official Commons API directly. It first pages through
 * geosearch results (title + coordinates), then requests image metadata for
 * those titles in batches. Keeping search and metadata requests separate
 * prevents continuation from reprocessing the same generator result set.
 * This is the same underlying data wikimap.toolforge.org shows on a map —
 * we skip that layer entirely and go straight to the source, so we're not
 * depending on a third-party Toolforge tool's uptime or rate limits.
 *
 * Usage:
 *   node fetch-commons-images.mjs --lat 37.2712 --lon -76.7112 --radius 400 --out ./data
 *
 * Flags:
 *   --max   hard cap on total images fetched, default 10000. The script stops
 *           paging as soon as it hits this (it does not keep going and trim
 *           after the fact except for the last partial page). If you hit the
 *           cap on page 1 or 2, your --radius is too wide for this location -
 *           narrow it rather than raising --max.
 *
 * Outputs (into --out, default ./data):
 *   commons-geosearch-raw.json   - full raw API response, for your records
 *   photos.scaffold.json         - starter entries for photos.json:
 *                                  id, file (source url), author/credit/license
 *                                  metadata, year (guess), lat, lon, source,
 *                                  license, building: null
 *
 * You still do Steps 2-5 from the build plan by hand: vet licenses, confirm
 * resolution, match each photo to a real building, and fold the scaffold
 * entries you keep into the real photos.json. This script just removes the
 * "manually copy 50 URLs out of a map UI" step.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://commons.wikimedia.org/w/api.php";

// Wikimedia asks every script to identify itself. Put a real contact here
// before you run this for real - it's required by their API usage policy,
// not optional politeness.
const USER_AGENT =
  "campus-comic-creator/1.0 (hackathon project; contact: eychan@wm.edu";

const RATE_LIMIT_MS = 1000; // be polite: ~1 request/sec, this is a one-time batch job
const METADATA_BATCH_SIZE = 50; // conservative title batch size for query prop requests

function parseArgs(argv) {
  const out = { lat: 37.2712, lon: -76.7112, radius: 400, out: "./data", limit: 500, max: 10000 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    const val = argv[i + 1];
    if (key in out) out[key] = key === "out" ? val : Number(val);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchGeosearchPage(lat, lon, radius, limit, continueToken) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "geosearch",
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(Math.min(radius, 10000)), // 10000m is the API's hard max
    ggsnamespace: "6", // File: namespace only
    ggslimit: String(Math.min(limit, 500)),
    prop: "coordinates",
  });
  if (continueToken) {
    for (const [k, v] of Object.entries(continueToken)) params.set(k, v);
  }

  const res = await fetch(`${API}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Commons API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchImageMetadata(titles) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "imageinfo",
    titles: titles.join("|"),
    iiprop: "url|size|extmetadata",
    iiurlwidth: "330",
  });
  const res = await fetch(`${API}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Commons API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function guessYear(extmetadata) {
  const raw =
    extmetadata?.DateTimeOriginal?.value ||
    extmetadata?.DateTime?.value ||
    "";
  const match = raw.match(/\b(1[5-9]\d\d|20\d\d)\b/);
  return match ? Number(match[0]) : null;
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

function toScaffoldEntry(page) {
  const info = page.imageinfo?.[0];
  const coord = page.coordinates?.[0];
  if (!info || !coord) return null;

  const slug = page.title
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const license =
    info.extmetadata?.LicenseShortName?.value ||
    info.extmetadata?.UsageTerms?.value ||
    "UNKNOWN - verify on file page";

  const metadata = info.extmetadata || {};
  // Artist/Credit come through as HTML (often an <a> to the photographer's
  // Commons user page). Keep both readable text and the link for attribution.
  const rawArtist = metadata.Artist?.value || "";
  const rawCredit = metadata.Credit?.value || "";
  const creator = plainText(rawArtist || rawCredit) || null;
  const creatorUrl = firstHref(rawArtist) || firstHref(rawCredit);
  const licenseUrl = metadata.LicenseUrl?.value || null;
  const description = plainText(metadata.ImageDescription?.value || "") || null;
  const dateOriginal = metadata.DateTimeOriginal?.value || metadata.DateTime?.value || null;

  return {
    id: slug,
    file: info.url, // full-resolution original; download this by hand after license review
    thumb: info.thumburl || null,
    year: guessYear(info.extmetadata),
    building: null, // fill in by hand - Step 3 of the build plan
    lat: coord.lat,
    lon: coord.lon,
    source: page.descriptionurl, // Commons File: description page - required for CC attribution, not the raw file URL
    license,
    licenseUrl,
    creator,
    creatorUrl,
    credit: plainText(rawCredit) || null,
    description,
    dateOriginal,
    width: info.width || null,
    height: info.height || null,
  };
}

async function main() {
  const { lat, lon, radius, out, limit, max } = parseArgs(process.argv.slice(2));

  console.log(
    `Fetching Commons geosearch: lat=${lat} lon=${lon} radius=${radius}m (cap: ${max})`
  );

  // Geosearch is the only paged phase. It returns file titles and coordinates;
  // continuation advances through actual nearby matches. NOTE: per MediaWiki's
  // own continuation docs, a generator+prop query can emit `continue` again
  // for the SAME page set while it's still resolving `prop` for pages already
  // returned, not just when there are new pages - so `continue` truthy is not
  // by itself proof of forward progress. Track how many *new* pageids each
  // response actually added and bail out once that stops happening, instead
  // of trusting continueToken alone (which is what caused this to spin
  // forever on page 2 previously).
  const pagesById = new Map();
  let continueToken = null;
  let searchPage = 0;
  let stallCount = 0;
  const MAX_STALLS = 3; // a couple of "same size" pages can be legitimate metadata-only continuation; more than that is a stuck loop

  do {
    searchPage += 1;
    const data = await fetchGeosearchPage(lat, lon, radius, limit, continueToken);
    const sizeBefore = pagesById.size;
    for (const p of Object.values(data.query?.pages || {})) {
      pagesById.set(p.pageid, { ...pagesById.get(p.pageid), ...p });
    }
    const added = pagesById.size - sizeBefore;
    continueToken = data.continue || null;
    console.log(`  geosearch page ${searchPage}: ${pagesById.size} unique files so far (+${added})`);

    if (pagesById.size >= max) {
      console.log(`  hit cap of ${max}, stopping (radius=${radius}m may be too wide for this cap)`);
      continueToken = null;
      break;
    }

    if (added === 0 && continueToken) {
      stallCount += 1;
      console.log(`  no new files this page (stall ${stallCount}/${MAX_STALLS})`);
      if (stallCount >= MAX_STALLS) {
        console.log(`  geosearch stopped returning new files but kept sending a continue token - stopping here rather than looping forever.`);
        console.log(`  (this can happen when the API is still resolving properties for already-seen pages; if you expected more results, try a smaller --limit per page.)`);
        continueToken = null;
        break;
      }
    } else {
      stallCount = 0;
    }

    if (continueToken) await sleep(RATE_LIMIT_MS);
  } while (continueToken);

  const candidates = [...pagesById.values()].slice(0, max);
  const metadataByTitle = new Map();
  const batchCount = Math.ceil(candidates.length / METADATA_BATCH_SIZE);
  for (let offset = 0; offset < candidates.length; offset += METADATA_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + METADATA_BATCH_SIZE);
    const batchNum = Math.floor(offset / METADATA_BATCH_SIZE) + 1;
    try {
      const data = await fetchImageMetadata(batch.map((p) => p.title));
      for (const p of Object.values(data.query?.pages || {})) {
        metadataByTitle.set(p.title, p);
      }
      console.log(`  metadata batch ${batchNum}/${batchCount}`);
    } catch (err) {
      // Don't let one bad batch throw away every metadata fetch that already
      // succeeded (and the geosearch paging that got us here) - log it, skip
      // the batch, keep going. Missing titles just fall back to
      // "UNKNOWN - verify on file page" / null author fields in the scaffold,
      // same as any other partial-data case toScaffoldEntry() already handles.
      console.warn(`  metadata batch ${batchNum}/${batchCount} failed, skipping: ${err.message}`);
    }
    if (offset + METADATA_BATCH_SIZE < candidates.length) await sleep(RATE_LIMIT_MS);
  }

  const allPages = candidates.map((candidate) => ({
    ...candidate,
    ...(metadataByTitle.get(candidate.title) || {}),
  }));

  await mkdir(out, { recursive: true });

  await writeFile(
    path.join(out, "commons-geosearch-raw.json"),
    JSON.stringify(allPages, null, 2)
  );

  const scaffold = allPages.map(toScaffoldEntry).filter(Boolean);
  await writeFile(
    path.join(out, "photos.scaffold.json"),
    JSON.stringify(scaffold, null, 2)
  );

  console.log(`\nDone. ${allPages.length} candidates -> ${out}/commons-geosearch-raw.json`);
  console.log(`${scaffold.length} scaffold entries -> ${out}/photos.scaffold.json`);
  console.log(`\nNext: run Steps 2-5 from the build plan by hand on the scaffold,`);
  console.log(`then merge the keepers into your real photos.json. No further API calls needed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
