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
 * attributionSource(photo) -> { name, host } — derives the source platform
 * from photo.source's own host instead of assuming Wikimedia Commons.
 * ~half this dataset (see scripts/unify-photos.mjs) is Flickr-sourced, not
 * Commons, and every attribution site below used to hardcode "Wikimedia
 * Commons" regardless - this is the one place that mapping lives now, so
 * a third platform (or a photo.source that isn't a full URL at all) only
 * needs a change here, not at every render site.
 * Falls back to the bare host, or "the source" if photo.source is missing/
 * unparseable, rather than claiming a platform the link doesn't back up.
 */
function attributionSource(photo) {
  if (!photo.source) return { name: "the source", host: null };
  try {
    const host = new URL(photo.source).host.replace(/^www\./, "");
    if (host === "commons.wikimedia.org") return { name: "Wikimedia Commons", host };
    if (host === "flickr.com") return { name: "Flickr", host };
    return { name: host, host };
  } catch {
    return { name: "the source", host: null };
  }
}

/**
 * attributionLine(photo) -> plain-text CC-style attribution, e.g.
 * `"James Blair Hall, College of William and Mary (3859960606)" by Jane
 * Doe, CC BY-SA 2.0, via Wikimedia Commons -
 * https://commons.wikimedia.org/wiki/File:...` for a Commons photo, or
 * `..., via Flickr - https://www.flickr.com/photos/...` for a Flickr one.
 * `photo.source` is the platform's own description/detail page for the
 * photo (not a redirect/thumbnail/raw-upload URL), which is what the
 * license actually requires linking to, on either platform.
 */
function attributionLine(photo) {
  const title = photo.title || buildingLabel(photo);
  const creator = photo.creator ? ` by ${photo.creator}` : "";
  const license = photo.license || "license unknown";
  const link = photo.source || "#";
  const { name: platform } = attributionSource(photo);
  return `"${title}"${creator}, ${license}, via ${platform} - ${link}`;
}

/**
 * creditListItemHTML(photo) -> one <li> for the clickable credits list -
 * shared by js/app.js's renderCredits() and js/comic.js's
 * renderPathCredits() so the Commons-vs-Flickr link text (and the
 * creator-name-links-to-creatorUrl touch) only has to be right in one
 * place. `label` lets callers pick building-name-first (comic) vs.
 * buildingLabel()-with-building-fallback (map) without duplicating the
 * rest of the row.
 */
function creditListItemHTML(photo, label) {
  const creatorText = photo.creator
    ? photo.creatorUrl
      ? ` — photo by <a href="${photo.creatorUrl}" target="_blank" rel="noopener">${photo.creator}</a>`
      : ` — photo by ${photo.creator}`
    : "";
  const { name: platform } = attributionSource(photo);
  return (
    `<li>${label}, ${photo.year ?? "?"}${creatorText} — ${photo.license ?? "license unknown"} — ` +
    `<a href="${photo.source ?? "#"}" target="_blank" rel="noopener">${platform} file page</a></li>`
  );
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
