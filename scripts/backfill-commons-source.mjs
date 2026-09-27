#!/usr/bin/env node
/**
 * backfill-commons-source.mjs — pure data recovery, no network calls.
 *
 * data/photos.scaffold.json (and anything copied from it into
 * data/photos.json) is missing `source` (the Commons File: description
 * page URL, required for CC attribution) on every entry, even though
 * data/commons-geosearch-raw.json - the original API response, still
 * sitting in the repo - has it for all 183. This rejoins the two by id
 * (scaffold's `id` is a slugified version of the raw dump's `title`) and
 * fills in `source` wherever it's missing, WITHOUT touching any field a
 * human may have already hand-edited (building, lat, lon, year - same
 * preserve-if-set convention as scripts/download-wikimedia-photos.mjs).
 *
 * Only backfills `source` by default. Pass --fields to backfill others
 * that are recoverable the same way (creator, creatorUrl, license,
 * licenseUrl, credit, description, dateOriginal) if those ever go missing
 * too - same rejoin, just copying more keys across.
 *
 * Usage:
 *   node scripts/backfill-commons-source.mjs data/photos.scaffold.json
 *   node scripts/backfill-commons-source.mjs data/photos.json
 *   node scripts/backfill-commons-source.mjs data/photos.json --fields source,creator,creatorUrl
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

function fromRawEntry(page) {
  const info = page.imageinfo?.[0];
  const metadata = info?.extmetadata || {};
  const rawArtist = metadata.Artist?.value || "";
  const rawCredit = metadata.Credit?.value || "";
  const plainText = (v = "") =>
    v.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const firstHref = (v = "") => {
    const m = v.match(/href=["']([^"']+)["']/i);
    if (!m) return null;
    return m[1].startsWith("//") ? `https:${m[1]}` : m[1];
  };
  return {
    source: info?.descriptionurl || null,
    creator: plainText(rawArtist || rawCredit) || null,
    creatorUrl: firstHref(rawArtist) || firstHref(rawCredit) || null,
    license: metadata.LicenseShortName?.value || metadata.UsageTerms?.value || null,
    licenseUrl: metadata.LicenseUrl?.value || null,
    credit: plainText(rawCredit) || null,
    description: plainText(metadata.ImageDescription?.value || "") || null,
    dateOriginal: metadata.DateTimeOriginal?.value || metadata.DateTime?.value || null,
  };
}

async function main() {
  const target = process.argv[2];
  const fieldsArg = process.argv.find((a) => a.startsWith("--fields="));
  const fields = fieldsArg ? fieldsArg.replace("--fields=", "").split(",") : ["source"];

  if (!target) {
    console.error("Usage: node scripts/backfill-commons-source.mjs <path-to-photos-file.json> [--fields=source,creator,...]");
    process.exit(1);
  }

  const rawDump = JSON.parse(await readFile(path.join(ROOT, "data", "commons-geosearch-raw.json"), "utf8"));
  const byId = new Map(rawDump.map((page) => [slugify(page.title), fromRawEntry(page)]));

  const targetPath = path.resolve(target);
  const photos = JSON.parse(await readFile(targetPath, "utf8"));

  let filled = 0;
  let noMatch = 0;
  for (const photo of photos) {
    const recovered = byId.get(photo.id);
    if (!recovered) {
      noMatch++; // e.g. a hand-added or Flickr-sourced entry sitting in the same file - not in the Commons dump, nothing to recover
      continue;
    }
    let touchedThisEntry = false;
    for (const field of fields) {
      if ((photo[field] === null || photo[field] === undefined) && recovered[field] != null) {
        photo[field] = recovered[field];
        touchedThisEntry = true;
      }
    }
    if (touchedThisEntry) filled++;
  }

  await writeFile(targetPath, JSON.stringify(photos, null, 2) + "\n");
  console.log(`${target}: backfilled ${fields.join("/")} on ${filled} entries (${noMatch} had no matching Commons raw entry - fine if this file also holds hand-added/Flickr entries).`);
}

main();
