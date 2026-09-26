#!/usr/bin/env node
/**
 * fetch-commons-images.mjs
 *
 * ONE-TIME prep-day script. Run this by hand once (maybe twice, if you do a
 * "refresh" pass after a community-upload round). It is NOT called from the
 * deployed site and should never run during the hackathon or in the browser.
 *
 * Hits Wikimedia's official Commons API directly:
 *   action=query&generator=geosearch&prop=coordinates|imageinfo
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
 *                                  id, file (source url), year (guess), lat, lon,
 *                                  source, license, building: null
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
  "WM-Geospatial-Comic-Archive/1.0 (hackathon project; contact: REPLACE_ME@wm.edu)";

const RATE_LIMIT_MS = 1000; // be polite: ~1 request/sec, this is a one-time batch job

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

async function fetchPage(lat, lon, radius, limit, continueToken) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "geosearch",
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(Math.min(radius, 10000)), // 10000m is the API's hard max
    ggsnamespace: "6", // File: namespace only
    ggslimit: String(Math.min(limit, 500)),
    prop: "coordinates|imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: "330",
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

function guessYear(extmetadata) {
  const raw =
    extmetadata?.DateTimeOriginal?.value ||
    extmetadata?.DateTime?.value ||
    "";
  const match = raw.match(/\b(1[5-9]\d\d|20\d\d)\b/);
  return match ? Number(match[0]) : null;
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

  return {
    id: slug,
    file: info.url, // full-resolution original; download this by hand after license review
    thumb: info.thumburl || null,
    year: guessYear(info.extmetadata),
    building: null, // fill in by hand - Step 3 of the build plan
    lat: coord.lat,
    lon: coord.lon,
    source: page.descriptionurl,
    license,
  };
}

async function main() {
  const { lat, lon, radius, out, limit, max } = parseArgs(process.argv.slice(2));

  console.log(
    `Fetching Commons geosearch: lat=${lat} lon=${lon} radius=${radius}m (cap: ${max})`
  );

  // MediaWiki's `continue` mechanism for a geosearch generator with two
  // extra props (coordinates + imageinfo) doesn't page through NEW results
  // each round - it re-returns the SAME ~500 pages and fills in one more
  // prop batch per round (coordinates one round, imageinfo another). Naively
  // concatenating pages across rounds duplicates every page instead of
  // accumulating results, and worse, splits `coordinates` and `imageinfo`
  // across different copies of the same page. Merge by pageid instead.
  const pagesById = new Map();
  let continueToken = null;
  let page = 0;

  do {
    page += 1;
    const data = await fetchPage(lat, lon, radius, limit, continueToken);
    for (const p of Object.values(data.query?.pages || {})) {
      pagesById.set(p.pageid, { ...pagesById.get(p.pageid), ...p });
    }
    continueToken = data.continue || null;
    console.log(`  page ${page}: ${pagesById.size} unique pages so far`);

    if (pagesById.size >= max) {
      console.log(`  hit cap of ${max}, stopping (radius=${radius}m may be too wide for this cap)`);
      continueToken = null;
      break;
    }
    if (continueToken) await sleep(RATE_LIMIT_MS);
  } while (continueToken);

  const allPages = [...pagesById.values()].slice(0, max);

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
