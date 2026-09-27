#!/usr/bin/env node
/**
 * check-photos-exist.mjs
 *
 * You deleted assets/photos/raw/ locally, so a local fs check would just
 * report everything missing - not useful. This checks against GitHub
 * itself: whatever got committed and pushed is the real source of truth
 * now, and this script asks GitHub what's actually there instead of
 * assuming it matches what data/photos.json *thinks* exists.
 *
 * One API call (git trees, recursive) lists every path in the repo at a
 * given ref, then every entry's `file` (and `thumb`, when set) in the
 * target photos JSON is checked against that path list locally - no
 * per-file network request, so no rate-limit problem even at 600+ photos.
 *
 * Requires: the repo to actually be pushed to GitHub (this reads the
 * remote, not your working directory - your deleted local files don't
 * matter). Public repos work with no auth; for a private repo, or to
 * avoid GitHub's low unauthenticated rate limit, pass a token.
 *
 * Usage:
 *   node scripts/check-photos-exist.mjs --owner ORG --repo REPO
 *   node scripts/check-photos-exist.mjs --owner ORG --repo REPO --branch main
 *   node scripts/check-photos-exist.mjs --owner ORG --repo REPO --photos data/photos.flickr.json
 *   GITHUB_TOKEN=ghp_xxx node scripts/check-photos-exist.mjs --owner ORG --repo REPO
 *
 * If --owner/--repo are omitted, it tries to read them from
 * `git remote get-url origin` in the current repo checkout.
 *
 * Flags:
 *   --owner    GitHub org/user (falls back to git remote "origin")
 *   --repo     repo name (falls back to git remote "origin")
 *   --branch   ref to check against, default "main"
 *   --photos   which JSON file to check, default data/photos.json
 *              (repeatable: --photos data/photos.json --photos data/photos.flickr.json)
 *   --out      write full JSON results here too, default none (summary to stdout only)
 *
 * Exit code: 1 if anything is missing, 0 if everything referenced exists.
 */

import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = "https://api.github.com";

function parseArgs(argv) {
  const out = { branch: "main", photos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--owner") out.owner = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--branch") out.branch = argv[++i];
    else if (a === "--photos") out.photos.push(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
  }
  if (out.photos.length === 0) out.photos.push("data/photos.json");
  return out;
}

function guessOwnerRepoFromGitRemote() {
  try {
    const url = execSync("git remote get-url origin", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    // handles git@github.com:owner/repo.git and https://github.com/owner/repo(.git)
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    // no git checkout, or no "origin" remote - caller must pass --owner/--repo
  }
  return {};
}

async function githubFetch(url) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "check-photos-exist-script" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchRepoPaths(owner, repo, branch) {
  const data = await githubFetch(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (data.truncated) {
    console.warn(
      "  WARNING: GitHub truncated the tree response (repo has more entries than one call returns). " +
        "Results below may report false positives for paths past the truncation point."
    );
  }
  return new Set(data.tree.filter((e) => e.type === "blob").map((e) => e.path));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.owner || !opts.repo) {
    const guessed = guessOwnerRepoFromGitRemote();
    opts.owner = opts.owner || guessed.owner;
    opts.repo = opts.repo || guessed.repo;
  }
  if (!opts.owner || !opts.repo) {
    console.error("Could not determine owner/repo. Pass --owner and --repo explicitly.");
    process.exit(1);
  }

  console.log(`Fetching file list for ${opts.owner}/${opts.repo}@${opts.branch} from GitHub...`);
  const repoPaths = await fetchRepoPaths(opts.owner, opts.repo, opts.branch);
  console.log(`  ${repoPaths.size} files found in repo at that ref.\n`);

  const results = [];
  for (const photosFile of opts.photos) {
    const fullPath = path.join(ROOT, photosFile);
    let entries;
    try {
      entries = JSON.parse(await readFile(fullPath, "utf8"));
    } catch (err) {
      console.error(`  Skipping ${photosFile}: ${err.message}`);
      continue;
    }

    const missing = [];
    for (const entry of entries) {
      for (const field of ["file", "thumb"]) {
        const p = entry[field];
        if (typeof p !== "string" || !p.length) continue; // null thumb etc - not a broken reference, just absent
        if (p.startsWith("http://") || p.startsWith("https://")) continue; // remote URL, not a repo path - nothing to check
        if (!repoPaths.has(p)) {
          missing.push({ id: entry.id, field, path: p });
        }
      }
    }

    console.log(`${photosFile}: ${entries.length} entries checked, ${missing.length} broken references.`);
    for (const m of missing.slice(0, 25)) {
      console.log(`  - [${m.field}] ${m.id} -> ${m.path}`);
    }
    if (missing.length > 25) console.log(`  ...and ${missing.length - 25} more.`);

    results.push({ photosFile, checked: entries.length, missing });
  }

  if (opts.out) {
    await writeFile(path.join(ROOT, opts.out), JSON.stringify(results, null, 2) + "\n");
    console.log(`\nFull results written to ${opts.out}`);
  }

  const totalMissing = results.reduce((sum, r) => sum + r.missing.length, 0);
  if (totalMissing > 0) {
    console.log(`\n${totalMissing} broken reference(s) total.`);
    process.exit(1);
  }
  console.log("\nEverything referenced exists in the repo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
