#!/usr/bin/env node
/**
 * generate-voiceover.mjs
 *
 * ONE-TIME prep-day script (run after data/story.ink's content is final).
 * Calls ElevenLabs' text-to-speech API once per Ink knot and writes the
 * result to assets/audio/<knot_id>.mp3. js/story.js's playVoiceover()
 * already looks for files at exactly that path and plays them if present -
 * this script is the other half of that wiring, nothing else needs to
 * change once audio files exist.
 *
 * NEVER call this from the browser / deployed site / during judging - it's
 * a prep-day batch job only. Live TTS calls during a demo trade a real
 * latency + failure-mode risk for no benefit, since the script content is
 * fixed and known ahead of time.
 *
 * Setup:
 *   cp .env.example .env
 *   # fill in ELEVENLABS_API_KEY (event-provided key)
 *   node --env-file=.env scripts/generate-voiceover.mjs
 *
 * This script does NOT parse data/story.ink directly (Ink's plain-text
 * source isn't a clean thing to regex). Instead, maintain a small
 * PASSAGES map below - one entry per knot you want voiced - and keep it in
 * sync with data/story.ink by hand. This is intentional: it's a much
 * smaller surface area to get wrong than trying to auto-extract text from
 * Ink source, and it lets you skip voicing knots you don't care about
 * (e.g. skip epilogue variants first if you're short on API quota).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1/text-to-speech";
const OUT_DIR = "./assets/audio";

// Default ElevenLabs sample voice ("Rachel"). Swap in a real voice ID per
// character once you've picked one from https://elevenlabs.io/app/voice-lab.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

// --- FILL THIS IN to match data/story.ink -----------------------------
// key = knot id (matches the `# bg:` tag value / photos.json `id`)
// text = the line(s) to voice. Keep in sync with the Ink source by hand.
const PASSAGES = {
  // wren_building: {
  //   text: "The light falls the same way it did when this was drawn.",
  //   voiceId: process.env.ELEVENLABS_VOICE_ID_MARA || DEFAULT_VOICE_ID,
  // },
};
// ------------------------------------------------------------------------

async function synthesize(text, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY not set. Copy .env.example to .env and fill in " +
        "the event-provided key, then run with --env-file=.env (Node 20.6+)."
    );
  }

  const res = await fetch(`${ELEVENLABS_API}/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs API error ${res.status}: ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const entries = Object.entries(PASSAGES);
  if (entries.length === 0) {
    console.log(
      "PASSAGES is empty - add entries matching your data/story.ink knots " +
        "before running this for real. See the comment block at the top of " +
        "this file."
    );
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  for (const [knotId, { text, voiceId }] of entries) {
    console.log(`Synthesizing "${knotId}" (${text.length} chars)...`);
    const audio = await synthesize(text, voiceId || DEFAULT_VOICE_ID);
    const outPath = path.join(OUT_DIR, `${knotId}.mp3`);
    await writeFile(outPath, audio);
    console.log(`  -> ${outPath}`);
  }

  console.log(`\nDone. ${entries.length} lines voiced -> ${OUT_DIR}/`);
  console.log("Commit the .mp3 files - they're static assets the deployed site plays directly.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
