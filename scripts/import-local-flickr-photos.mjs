#!/usr/bin/env node
/**
 * import-local-flickr-photos.mjs
 *
 * ONE-TIME prep-day script. Makes NO network calls - it only reads files
 * you already have on disk (a Flickr bulk-download folder, e.g. one made
 * with a tool like flickr-download or similar) and copies/normalizes them
 * into this project's schema.
 *
 * Expects the tree shape you already have:
 *   <root>/
 *     <Owner Name>/
 *       flickr_<id>.jpg
 *       flickr_<id>.jpg.json     (Flickr API photo-info shape - id, owner,
 *                                  title, description, license, dates,
 *                                  location, url/width/height, urls.url[])
 *
 * For every matched (.jpg + .jpg.json) pair it finds anywhere under <root>:
 *   - parses the sidecar JSON
 *   - maps Flickr's numeric license id to a human-readable license string
 *     (matching the license field style already used in data/photos.json)
 *   - copies the image into assets/photos/raw/flickr_<id>.jpg (a plain
 *     local file copy, nothing is fetched from the network)
 *   - writes a photos.json-shaped entry to --out (default:
 *     data/photos.flickr.json) - a NEW file, not a merge into the real
 *     data/photos.json, so you still do the same per-image building-match
 *     triage (Step 3 of the build plan) before folding entries into the
 *     real curated dataset. Flickr photos carry real GPS coordinates
 *     (unlike ~78% of the Commons pool), so triage here is mostly "which
 *     building is nearest" rather than "is there any location info at all".
 *
 * License handling: Flickr license id "0" is All Rights Reserved - those
 * entries are EXCLUDED from the output entirely (not usable at all).
 * License ids "3" and "6" are NoDerivs licenses - these are INCLUDED but
 * flagged (`derivativesAllowed: false`) because this project's whole
 * pipeline stylizes (derives from) source photos; a NoDerivs photo can be
 * shown as-is but should not be run through stylize.js. Review the
 * flagged list this script prints before curating those into photos.json.
 *
 * Usage:
 *   node scripts/import-local-flickr-photos.mjs --in ~/downloads/flickr --dry-run
 *   node scripts/import-local-flickr-photos.mjs --in ~/downloads/flickr
 *
 * Flags:
 *   --in       root folder to walk (required)
 *   --out      output file (default: data/photos.flickr.json)
 *   --raw-dir  where images get copied (default: assets/photos/raw)
 *   --force    overwrite already-copied files
 *   --dry-run  preview only, copies/writes nothing
 */

import { readdir, readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const MIN_LONG_EDGE = 1500;

// Official Flickr API license ids (flickr.photos.licenses.getInfo).
const LICENSE_MAP = {
  0: { license: "All Rights Reserved", licenseUrl: null, derivativesAllowed: false, usable: false },
  1: { license: "CC BY-NC-SA 2.0", licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/2.0/", derivativesAllowed: true, usable: true },
  2: { license: "CC BY-NC 2.0", licenseUrl: "https://creativecommons.org/licenses/by-nc/2.0/", derivativesAllowed: true, usable: true },
  3: { license: "CC BY-NC-ND 2.0", licenseUrl: "https://creativecommons.org/licenses/by-nc-nd/2.0/", derivativesAllowed: false, usable: true },
  4: { license: "CC BY 2.0", licenseUrl: "https://creativecommons.org/licenses/by/2.0/", derivativesAllowed: true, usable: true },
  5: { license: "CC BY-SA 2.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/", derivativesAllowed: true, usable: true },
  6: { license: "CC BY-ND 2.0", licenseUrl: "https://creativecommons.org/licenses/by-nd/2.0/", derivativesAllowed: false, usable: true },
  7: { license: "No known copyright restrictions", licenseUrl: null, derivativesAllowed: true, usable: true },
  8: { license: "United States Government Work", licenseUrl: null, derivativesAllowed: true, usable: true },
  9: { license: "Public Domain (CC0)", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", derivativesAllowed: true, usable: true },
  10: { license: "Public Domain Mark", licenseUrl: null, derivativesAllowed: true, usable: true },
};

function parseArgs(argv) {
  const out = {
    in: null,
    out: "./data/photos.flickr.json",
    rawDir: "./assets/photos/raw",
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in") out.in = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--raw-dir") out.rawDir = argv[++i];
    else if (arg === "--force") out.force = true;
    else if (arg === "--dry-run") out.dryRun = true;
  }
  if (!out.in) {
    console.error("Missing required --in <folder>. Point this at your flickr download root.");
    process.exit(1);
  }
  return out;
}

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Recursive walk without relying on Node 20's readdir({recursive:true}),
// so this runs on older Node too.
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(await walk(full));
    else files.push(full);
  }
  return files;
}

function plainText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function yearFromTaken(dates) {
  const raw = dates?.taken || "";
  const match = raw.match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function photopageUrl(json) {
  const found = json.urls?.url?.find((u) => u.type === "photopage");
  return found?._content || json.urls?.url?.[0]?._content || null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Walking ${opts.in} for flickr_<id>.jpg + .json pairs...`);
  const allFiles = await walk(opts.in);
  const jsonFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".json"));

  const entries = [];
  const skippedNoImage = [];
  const skippedAllRightsReserved = [];
  const flaggedNoDerivs = [];
  const flaggedNeedsGeolocation = [];
  const flaggedForResolution = [];

  for (const jsonPath of jsonFiles) {
    const imagePath = jsonPath.replace(/\.json$/i, "");
    if (!(await exists(imagePath))) {
      skippedNoImage.push(jsonPath);
      continue;
    }

    const json = JSON.parse(await readFile(jsonPath, "utf-8"));
    const licenseInfo = LICENSE_MAP[String(json.license)] ?? LICENSE_MAP[Number(json.license)];

    if (!licenseInfo || !licenseInfo.usable) {
      skippedAllRightsReserved.push(json.id);
      continue;
    }

    const id = `flickr_${json.id}`;
    const ext = path.extname(imagePath) || ".jpg";
    const destRelPath = path.join(opts.rawDir, `${id}${ext}`).replace(/\\/g, "/");
    const destAbsPath = path.join(opts.rawDir, `${id}${ext}`);

    const lat = json.location?.latitude ? parseFloat(json.location.latitude) : null;
    const lon = json.location?.longitude ? parseFloat(json.location.longitude) : null;
    const needsGeolocation = !lat || !lon || (lat === 0 && lon === 0);

    if (!opts.dryRun) {
      await mkdir(opts.rawDir, { recursive: true });
      if (opts.force || !(await exists(destAbsPath))) {
        await copyFile(imagePath, destAbsPath);
        console.log(`  [copy] ${path.basename(imagePath)} -> ${destAbsPath}`);
      } else {
        console.log(`  [copy] ${destAbsPath} already exists, skipping (use --force to redo)`);
      }
    } else {
      console.log(`  [copy] would copy ${imagePath} -> ${destAbsPath}`);
    }

    const entry = {
      id,
      file: destRelPath,
      thumb: null, // no local thumb generated (no image-processing dependency) - app falls back to file
      year: yearFromTaken(json.dates),
      building: null, // still needs the same by-hand building-match triage as the Commons pool
      lat: needsGeolocation ? null : lat,
      lon: needsGeolocation ? null : lon,
      needs_geolocation: needsGeolocation,
      source: photopageUrl(json),
      license: licenseInfo.license,
      licenseUrl: licenseInfo.licenseUrl,
      derivativesAllowed: licenseInfo.derivativesAllowed,
      creator: json.owner?.realname || json.owner?.username || null,
      creatorUrl: json.owner?.path_alias
        ? `https://www.flickr.com/people/${json.owner.path_alias}`
        : json.owner?.nsid
        ? `https://www.flickr.com/people/${json.owner.nsid}`
        : null,
      title: json.title || null,
      description: plainText(json.description || "") || null,
      width: json.width || null,
      height: json.height || null,
    };

    if (!licenseInfo.derivativesAllowed) flaggedNoDerivs.push(id);
    if (needsGeolocation) flaggedNeedsGeolocation.push(id);
    const longEdge = Math.max(entry.width || 0, entry.height || 0);
    if (longEdge && longEdge < MIN_LONG_EDGE) flaggedForResolution.push({ id, longEdge });

    entries.push(entry);
  }

  if (!opts.dryRun) {
    await writeFile(opts.out, JSON.stringify(entries, null, 2));
    console.log(`\nWrote ${entries.length} entries to ${opts.out}.`);
  } else {
    console.log(`\nDry run - would write ${entries.length} entries to ${opts.out}.`);
  }

  console.log(`\n${jsonFiles.length} sidecar JSON files found.`);
  if (skippedNoImage.length) {
    console.log(`${skippedNoImage.length} skipped - no matching image file next to the .json.`);
  }
  if (skippedAllRightsReserved.length) {
    console.log(`${skippedAllRightsReserved.length} skipped entirely - All Rights Reserved (license 0), not usable: ${skippedAllRightsReserved.join(", ")}`);
  }
  if (flaggedNoDerivs.length) {
    console.log(`\n${flaggedNoDerivs.length} entr${flaggedNoDerivs.length === 1 ? "y is" : "ies are"} NoDerivs-licensed - do NOT run these through stylize.js, show as-is only or drop them:`);
    for (const id of flaggedNoDerivs) console.log(`  - ${id}`);
  }
  if (flaggedNeedsGeolocation.length) {
    console.log(`\n${flaggedNeedsGeolocation.length} entr${flaggedNeedsGeolocation.length === 1 ? "y needs" : "ies need"} manual lat/lon (no usable GPS in the Flickr metadata):`);
    for (const id of flaggedNeedsGeolocation) console.log(`  - ${id}`);
  }
  if (flaggedForResolution.length) {
    console.log(`\n${flaggedForResolution.length} entr${flaggedForResolution.length === 1 ? "y" : "ies"} below the ${MIN_LONG_EDGE}px long-edge bar:`);
    for (const f of flaggedForResolution) console.log(`  - ${f.id} (long edge ${f.longEdge}px)`);
  }

  console.log(`\nNext: hand-match each entry in ${opts.out} to a building (same as Step 3 for Commons),`);
  console.log(`then copy the keepers into data/photos.json.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
