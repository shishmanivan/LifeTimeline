/**
 * Local image cache for historical events.
 * Rule: manifest (date|url) first for exact file, then by date.
 * Tries extensions: .webp, .jpg, .jpeg, .png, .avif, .svg.
 *
 * Main layer reads only from `HistoryPics/`.
 * Culture layer reads only from `HistoryPics/Culture/`.
 */

import mainManifest from "./HistoryPics/_manifest.json";
import cultureManifest from "./HistoryPics/Culture/_manifest.json";

/** Must match fetchHistoryPics: normalize URL for consistent manifest lookup */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* keep as-is */
    }
    pathname = pathname.replace(/\/+$/, "");
    return `${u.origin}${pathname}`;
  } catch {
    return url;
  }
}

const mainPicModules = import.meta.glob<string>(
  "./HistoryPics/*.{png,jpg,jpeg,webp,avif,svg}",
  { eager: true, import: "default" }
);

const culturePicModules = import.meta.glob<string>(
  "./HistoryPics/Culture/*.{png,jpg,jpeg,webp,avif,svg}",
  { eager: true, import: "default" }
);

const mainFilenameToUrl = new Map<string, string>();
for (const [modulePath, url] of Object.entries(mainPicModules)) {
  const filename = modulePath.replace(/^.*[/\\]/, "");
  mainFilenameToUrl.set(filename, url);
}

const cultureFilenameToUrl = new Map<string, string>();
for (const [modulePath, url] of Object.entries(culturePicModules)) {
  const filename = modulePath.replace(/^.*[/\\]/, "");
  cultureFilenameToUrl.set(filename, url);
}

const EXTENSIONS = [".webp", ".jpg", ".jpeg", ".png", ".avif", ".svg"];

function tryByBaseName(
  base: string,
  filenameToUrl: Map<string, string>
): string | undefined {
  for (const ext of EXTENSIONS) {
    const url = filenameToUrl.get(base + ext);
    if (url) return url;
  }
  return undefined;
}

export function getLocalImageUrl(event: {
  date: string;
  url: string;
  sourceFile?: string;
}): string | undefined {
  const isCulture =
    event.sourceFile?.toLowerCase().includes("culture") ||
    event.sourceFile?.toLowerCase().includes("культура");
  const manifest = isCulture
    ? (cultureManifest as Record<string, string>)
    : (mainManifest as Record<string, string>);
  const filenameToUrl = isCulture ? cultureFilenameToUrl : mainFilenameToUrl;

  // Manifest first: exact file (e.g. .svg) avoids broken .webp with wrong content
  const key = `${event.date}|${normalizeUrl(event.url)}`;
  const filename = manifest[key];
  if (filename) {
    const exact = filenameToUrl.get(filename);
    if (exact) return exact;
    const base = filename.includes(".") ? filename.replace(/\.[^.]+$/, "") : filename;
    const byManifest = tryByBaseName(base, filenameToUrl);
    if (byManifest) return byManifest;
  }
  const byDate = tryByBaseName(event.date, filenameToUrl);
  if (byDate) return byDate;
  return undefined;
}
