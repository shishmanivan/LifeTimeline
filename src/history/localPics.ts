/**
 * Local image cache for historical events.
 * Rule: manifest (date|url) first for exact file, then by date.
 * Tries extensions: .webp, .jpg, .jpeg, .jfif, .png, .avif, .svg.
 *
 * Main layer reads only from `HistoryPics/`.
 * Culture layer reads only from `HistoryPics/Culture/`.
 * Autos layer reads only from `HistoryPics/Autos/`.
 */

import mainManifest from "./HistoryPics/_manifest.json";
import cultureManifest from "./HistoryPics/Culture/_manifest.json";
import autosManifest from "./HistoryPics/Autos/_manifest.json";

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
  "./HistoryPics/*.{png,jpg,jpeg,jfif,webp,avif,svg}",
  { eager: true, import: "default" }
);

const culturePicModules = import.meta.glob<string>(
  "./HistoryPics/Culture/*.{png,jpg,jpeg,jfif,webp,avif,svg}",
  { eager: true, import: "default" }
);

const autosPicModules = import.meta.glob<string>(
  "./HistoryPics/Autos/*.{png,jpg,jpeg,jfif,webp,avif,svg}",
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

const autosFilenameToUrl = new Map<string, string>();
for (const [modulePath, url] of Object.entries(autosPicModules)) {
  const filename = modulePath.replace(/^.*[/\\]/, "");
  autosFilenameToUrl.set(filename, url);
}

const EXTENSIONS = [".webp", ".jpg", ".jpeg", ".jfif", ".png", ".avif", ".svg"];

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

type PicsKind = "main" | "culture" | "autos";

function getPicsKind(sourceFile?: string): PicsKind {
  const f = (sourceFile ?? "").toLowerCase().replace(/\\/g, "/");
  if (f.includes("culture") || f.includes("культура")) return "culture";
  if (f.includes("autos/")) return "autos";
  return "main";
}

export function getLocalImageUrl(event: {
  date: string;
  url: string;
  sourceFile?: string;
}): string | undefined {
  const kind = getPicsKind(event.sourceFile);
  const manifest =
    kind === "culture"
      ? (cultureManifest as Record<string, string>)
      : kind === "autos"
        ? (autosManifest as Record<string, string>)
        : (mainManifest as Record<string, string>);
  const filenameToUrl =
    kind === "culture"
      ? cultureFilenameToUrl
      : kind === "autos"
        ? autosFilenameToUrl
        : mainFilenameToUrl;

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
