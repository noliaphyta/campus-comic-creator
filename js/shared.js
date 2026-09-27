/**
 * shared.js — the handful of helpers both index.html (js/app.js) and
 * comic.html (js/comic.js) need verbatim. Load this before either page
 * script. Kept intentionally tiny: if a function starts needing
 * page-specific behavior, move it back out rather than growing branches
 * here.
 */

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

/**
 * buildingLabel(photo) — human-readable label for a photo. Prefers the
 * confirmed building name; when there isn't one (most of the
 * promoted-but-unmatched dataset - see promote-photos.mjs), falls back to a
 * cleaned-up version of the Commons title instead of the raw slug `id`
 * (the entire image file name concatenated with underscores, e.g.
 * "the_wren_building_5170250013" - not fit to show anyone).
 */
function buildingLabel(photo) {
  if (photo.building) return photo.building;
  const base = (photo.title || photo.id || "Unknown")
    .replace(/^File:/, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s*\(\d+\)\s*$/, "") // drop the trailing Wikimedia page-id
    .trim();
  return base || "Unknown";
}

/**
 * attributionLine(photo) -> plain-text CC-style attribution, e.g.
 * `"James Blair Hall, College of William and Mary (3859960606)" by Jane
 * Doe, CC BY-SA 2.0, via Wikimedia Commons -
 * https://commons.wikimedia.org/wiki/File:...`
 * `photo.source` is the Wikimedia Commons File: description page (not a
 * redirect/thumbnail/raw-upload URL), which is what the license actually
 * requires linking to.
 */
function attributionLine(photo) {
  const title = photo.title || buildingLabel(photo);
  const creator = photo.creator ? ` by ${photo.creator}` : "";
  const license = photo.license || "license unknown";
  const link = photo.source || "#";
  return `"${title}"${creator}, ${license}, via Wikimedia Commons - ${link}`;
}

/**
 * wireAppBadge() — the floating "#app-badge" title/tagline card (see
 * css/style.css's .floating-badge) is its own dismiss control: clicking
 * anywhere on it hides it for the rest of the session (sessionStorage, not
 * localStorage - a fresh visit should see it again, unlike the dark-mode
 * preference). comic.html's badge also contains a real "back to the map"
 * link (#back-to-map); that link needs to navigate normally rather than
 * being swallowed by the badge's own click-to-dismiss handler, so it's
 * explicitly excluded below. Keyboard-operable (Enter/Space) since the
 * badge is a role="button" div, not a real <button>.
 */
function wireAppBadge() {
  const badge = document.getElementById("app-badge");
  if (!badge) return;

  if (sessionStorage.getItem("ccc_badge_dismissed") === "true") {
    badge.hidden = true;
    return;
  }

  const dismiss = (evt) => {
    if (evt.target.closest("#back-to-map")) return; // let the link navigate
    badge.hidden = true;
    try {
      sessionStorage.setItem("ccc_badge_dismissed", "true");
    } catch (err) {
      console.warn("Could not persist badge dismissal for this session.", err);
    }
  };

  badge.addEventListener("click", dismiss);
  badge.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      dismiss(evt);
    }
  });
}
