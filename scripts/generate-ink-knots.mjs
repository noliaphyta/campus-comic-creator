#!/usr/bin/env node
/**
 * generate-ink-knots.mjs — drafts Ink knots for photos that don't have one
 * yet, from data/photos.json, in the same shape as the hand-written knots
 * in data/story.ink (see docs/narrative-system.md Track 2 for the brief
 * this mirrors: one knot per photo id, a mood/knowledge-reactive line, two
 * converging choices each with a `# feel:` tag, ending `-> DONE`).
 *
 * This is a DRAFTING tool, not a content pipeline: the output is
 * templated, not written, and is meant to be read and edited by a human
 * before it's real content - same bar the doc sets for hand-written knots.
 * It never touches data/story.ink directly; it writes a separate
 * data/story.generated.ink for review, so nothing hand-authored can be
 * clobbered by re-running it.
 *
 * Usage:
 *   node scripts/generate-ink-knots.mjs                # confirmed buildings only (the safe default)
 *   node scripts/generate-ink-knots.mjs --all           # also draft knots for photos with only a guessed building
 *   node scripts/generate-ink-knots.mjs --limit 20       # cap how many knots are drafted (handy while testing)
 *   node scripts/generate-ink-knots.mjs --out path.ink   # write somewhere other than data/story.generated.ink
 *   node scripts/generate-ink-knots.mjs --dry-run        # print the summary only, write nothing
 *
 * After reviewing/editing the output:
 *   1. Move the knots you're happy with into data/story.ink (before the
 *      ---- EPILOGUES ---- section).
 *   2. Compile with Inky or inklecate to data/story.ink.json.
 *   3. Delete data/story.generated.ink - it's a scratch file, not a
 *      long-term source of truth.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const includeUnconfirmed = args.includes("--all");
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit"));
const limit = limitArg
  ? Number(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf(limitArg) + 1])
  : Infinity;
const outArg = args.find((a) => a.startsWith("--out"));
const outPath = outArg
  ? path.resolve(ROOT, outArg.includes("=") ? outArg.split("=")[1] : args[args.indexOf(outArg) + 1])
  : path.join(ROOT, "data", "story.generated.ink");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOT_RE = /^\s*={2,}\s*([A-Za-z_][A-Za-z0-9_]*)\s*={0,}\s*$/gm;

// buildingLabel()'s fallback half, duplicated here in plain JS (see
// js/shared.js) since this script runs in Node, not the browser, and it's
// a two-line rule not worth sharing a module over.
function titleFallback(photo) {
  const base = (photo.title || photo.id || "Unknown")
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
  return base || "Unknown";
}

// Small deterministic hash so the SAME photo always picks the SAME
// template variant on every run - re-running the script with no changes
// to photos.json produces byte-identical output, so diffs stay meaningful.
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pick(list, seed) {
  return list[seed % list.length];
}

// ---- Templates -------------------------------------------------------
// Several variants per slot so a batch of drafts doesn't all read as the
// same sentence with the name swapped. Still deliberately plain - these
// are placeholders for a human editing pass, not finished prose.

const OPENERS = [
  (name) => `${name} meets the route at an angle you didn't expect, and the photograph asks you to slow down and actually look.`,
  (name) => `The path brings you level with ${name} before you're quite ready for it - one more stop the archive has kept waiting.`,
  (name) => `${name} sits at the edge of the frame the way it's probably sat at the edge of a thousand ordinary days.`,
  (name) => `Something about ${name} holds the light differently than the buildings around it, or maybe that's just the photograph.`,
  (name) => `You reach ${name} mid-thought, the kind of stop that only afterward turns out to have mattered.`,
];

const YEAR_CLAUSES = [
  (year) => ` The image dates to ${year}, close enough to now that the gap feels almost companionable.`,
  (year) => ` Whatever's changed since ${year}, the outline in front of you hasn't moved much.`,
  (year) => ` ${year} isn't so far back, but campus keeps its own sense of time.`,
];

const REACTIVE_LINES = [
  {
    mood: (name) => `You've been loosening into this walk for a while, and ${name} doesn't ask you to tighten back up.`,
    else: (name) => `You're still finding your footing here, and ${name} gives you a reasonable place to do it.`,
  },
  {
    mood: (name) => `Whatever you noticed a few stops back is still with you, coloring how ${name} reads.`,
    else: (name) => `Nothing yet has told you how to feel about ${name} - so you decide for yourself.`,
  },
  {
    mood: (name) => `${name} doesn't need explaining right now; you're content to just be near it.`,
    else: (name) => `${name} feels like it's waiting on you to bring more attention than you've spent so far.`,
  },
];

const KNOWLEDGE_CHOICES = [
  {
    label: "Look for what the photograph doesn't explain",
    feel: "You file away one more thing the archive leaves unanswered.",
  },
  {
    label: "Try to place this moment in the building's longer history",
    feel: "You notice one more layer of the place.",
  },
  {
    label: "Read the scene like it's evidence of something",
    feel: "A small detail sticks with you.",
  },
];

const MOOD_CHOICES = [
  {
    label: "Let the building set the pace instead of the map",
    feel: "Your shoulders loosen as you keep looking.",
  },
  {
    label: "Just take the place in without a plan",
    feel: "The walk feels less like an itinerary and more like a walk.",
  },
  {
    label: "Keep moving and let the impression settle later",
    feel: "Momentum gives the stop its own kind of meaning.",
  },
];

function buildKnot(photo, { confirmed }) {
  const name = photo.building || photo.building_suggestion?.name || titleFallback(photo);
  const seed = hashString(photo.id);

  const opener = pick(OPENERS, seed)(name);
  const yearClause = photo.year ? pick(YEAR_CLAUSES, seed + 1)(photo.year) : "";
  const reactive = pick(REACTIVE_LINES, seed + 2);
  const kChoice = pick(KNOWLEDGE_CHOICES, seed + 3);
  const mChoice = pick(MOOD_CHOICES, seed + 4);

  const unconfirmedNote = confirmed
    ? ""
    : `// UNCONFIRMED: building_suggestion "${photo.building_suggestion?.name}" ` +
      `(${photo.building_suggestion?.distance_m}m away) - verify this is actually ${name} before treating this as real.\n`;

  return (
    `${unconfirmedNote}=== ${photo.id} ===\n` +
    `# bg: ${photo.id}\n` +
    `${opener}${yearClause}\n` +
    `{mood > 0:\n` +
    `    ${reactive.mood(name)}\n` +
    `- else:\n` +
    `    ${reactive.else(name)}\n` +
    `}\n` +
    `* [${kChoice.label}]\n` +
    `    ~ knowledge += 1\n` +
    `    # feel: ${kChoice.feel}\n` +
    `    -> DONE\n` +
    `* [${mChoice.label}]\n` +
    `    ~ mood += 1\n` +
    `    # feel: ${mChoice.feel}\n` +
    `    -> DONE\n`
  );
}

async function main() {
  const photosRaw = await readFile(path.join(ROOT, "data", "photos.json"), "utf8");
  const photos = JSON.parse(photosRaw);

  const storyInkPath = path.join(ROOT, "data", "story.ink");
  const storyInk = await readFile(storyInkPath, "utf8").catch(() => "");
  const existingKnots = new Set([...storyInk.matchAll(KNOT_RE)].map((m) => m[1]));

  const skippedExisting = [];
  const skippedInvalidId = [];
  const skippedNoBuilding = [];
  const candidates = [];

  for (const photo of photos) {
    if (existingKnots.has(photo.id)) {
      skippedExisting.push(photo.id);
      continue;
    }
    if (!IDENTIFIER_RE.test(photo.id)) {
      // Ink knot names can't start with a digit (three photo ids in this
      // dataset do, e.g. "112_jamestown_road") - that's a real mismatch
      // between data/photos.json and what Ink allows, not something this
      // script should paper over. Flagging it for the engineer instead.
      skippedInvalidId.push(photo.id);
      continue;
    }
    const confirmed = Boolean(photo.building);
    if (!confirmed && !includeUnconfirmed) {
      skippedNoBuilding.push(photo.id);
      continue;
    }
    if (!confirmed && !photo.building_suggestion) {
      // --all was passed but there's not even a guessed building to draft
      // reactive text about - nothing sensible to generate here.
      skippedNoBuilding.push(photo.id);
      continue;
    }
    candidates.push({ photo, confirmed });
  }

  const selected = candidates.slice(0, limit);
  const knots = selected.map(({ photo, confirmed }) => buildKnot(photo, { confirmed }));

  console.log(`Existing knots in data/story.ink: ${existingKnots.size}`);
  console.log(`Photos already covered (skipped): ${skippedExisting.length}`);
  console.log(`Photos skipped (invalid Ink identifier - needs an engineering fix): ${skippedInvalidId.length}`);
  if (skippedInvalidId.length) console.log(`  ${skippedInvalidId.join(", ")}`);
  console.log(`Photos skipped (no confirmed building${includeUnconfirmed ? " or suggestion" : ""}): ${skippedNoBuilding.length}`);
  console.log(`Knots drafted: ${knots.length}${limit !== Infinity ? ` (capped at --limit ${limit})` : ""}`);
  console.log(`  confirmed-building: ${selected.filter((s) => s.confirmed).length}`);
  console.log(`  unconfirmed/guessed: ${selected.filter((s) => !s.confirmed).length}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }
  if (!knots.length) {
    console.log("\nNothing to draft - not writing an empty file.");
    return;
  }

  const header =
    `// AUTO-GENERATED DRAFT — scripts/generate-ink-knots.mjs\n` +
    `// Templated placeholder text, not finished writing - read every knot,\n` +
    `// rewrite the prose, and double-check any "UNCONFIRMED" building match\n` +
    `// before moving a knot into data/story.ink. See docs/narrative-system.md\n` +
    `// Track 2 for the content budget/choice-writing rules these should\n` +
    `// still follow once you've rewritten them.\n\n`;

  await writeFile(outPath, header + knots.join("\n"), "utf8");
  console.log(`\nWrote ${knots.length} draft knot(s) to ${path.relative(ROOT, outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
