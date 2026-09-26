#!/usr/bin/env node
/**
 * suggest-building-match.mjs
 *
 * ONE-TIME prep-day curation assist, not a live/deployed-site feature.
 * Reads data/photos.scaffold.json (written by fetch-commons-images.mjs)
 * and data/buildings.geojson (written by fetch-buildings-overpass.mjs),
 * and for each scaffold entry with `building: null`, asks Gemini's vision
 * understanding which campus building the photo most likely shows.
 *
 * This is a SUGGESTION, not a decision: it writes a `building_suggestion`
 * + `building_suggestion_confidence` field alongside the existing `building:
 * null`, and a human still confirms (or overrides) before anything is
 * copied into the real data/photos.json. This mirrors the same
 * human-confirms-AI pattern as the macOS Vision background-isolation step -
 * keep that consistent, don't let this script auto-write photos.json.
 *
 * Setup:
 *   cp .env.example .env
 *   # fill in GEMINI_API_KEY (event-provided key)
 *   node --env-file=.env scripts/suggest-building-match.mjs
 *
 * Requires data/photos.scaffold.json and data/buildings.geojson to already
 * exist (run the two fetch-*.mjs scripts first).
 */

import { readFile, writeFile } from "node:fs/promises";

const GEMINI_API =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function imageToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

async function suggestBuilding(photo, buildingNames) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not set. Copy .env.example to .env and fill in the " +
        "event-provided key, then run with --env-file=.env (Node 20.6+)."
    );
  }

  const imageBase64 = await imageToBase64(photo.thumb || photo.file);

  const prompt =
    `This is a historical photo, possibly of a building on the William & Mary campus. ` +
    `Here is the list of known campus building names: ${buildingNames.join(", ")}. ` +
    `Which one, if any, does this photo most likely show? Respond as compact JSON only: ` +
    `{"building": "<exact name from the list, or null if none match>", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}`;

  const res = await fetch(`${GEMINI_API}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const cleaned = raw.replace(/^```json\s*|```$/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn(`  Could not parse Gemini response as JSON for ${photo.id}:`, raw);
    return { building: null, confidence: "low", reasoning: "unparseable response" };
  }
}

async function main() {
  const scaffold = JSON.parse(await readFile("./data/photos.scaffold.json", "utf-8"));
  const buildings = JSON.parse(await readFile("./data/buildings.geojson", "utf-8"));
  const buildingNames = buildings.features
    .map((f) => f.properties.name)
    .filter(Boolean);

  if (buildingNames.length === 0) {
    console.warn(
      "data/buildings.geojson has no named buildings yet - run " +
        "fetch-buildings-overpass.mjs first, or this script has nothing to match against."
    );
    return;
  }

  const candidates = scaffold.filter((p) => !p.building);
  console.log(`${candidates.length} photos without a building match. Asking Gemini...`);

  for (const photo of candidates) {
    console.log(`  ${photo.id}...`);
    const suggestion = await suggestBuilding(photo, buildingNames);
    photo.building_suggestion = suggestion.building;
    photo.building_suggestion_confidence = suggestion.confidence;
    photo.building_suggestion_reasoning = suggestion.reasoning;
    // Deliberately NOT setting photo.building here - a human confirms via
    // the normal curation pass (Steps 2-5 of docs/build-plan.md) and copies
    // the suggestion into the real building field themselves, in
    // data/photos.json, if they agree with it.
  }

  await writeFile("./data/photos.scaffold.json", JSON.stringify(scaffold, null, 2));
  console.log("\nDone. Suggestions written to data/photos.scaffold.json as building_suggestion.");
  console.log("Review each one by hand before copying into data/photos.json - see docs/build-plan.md.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
