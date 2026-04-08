/**
 * Resolve historical event images as URLs under `/history-pics/` (nginx static).
 * Image bytes are not bundled; only `_manifest.json` files are imported for date|url → filename.
 *
 * Lookup order:
 * 1. Exact key `date|normalizedUrl` in the manifest for the layer (from `sourceFile`).
 * 2. Fallback: manifest value whose basename (no extension) equals `event.date`.
 *
 * Layers (from `event.sourceFile`, same rules as before):
 * - `culture` — path contains `culture` (or `культура` for Cyrillic paths)
 * - `autos` — path contains `autos/`
 * - `tech` — path contains `tech/`
 * - else `main` — files at `/history-pics/<filename>` (no `/main/` prefix)
 */

import mainManifest from "./HistoryPics/_manifest.json";
import cultureManifest from "./HistoryPics/Culture/_manifest.json";
import autosManifest from "./HistoryPics/Autos/_manifest.json";
import techManifest from "./HistoryPics/Tech/_manifest.json";

const BASE = "/history-pics";
const EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".jfif", ".avif", ".svg"];

type PicsKind = "main" | "culture" | "autos" | "tech";

/** Must match tools/fetchHistoryPics*.ts: normalize URL for consistent manifest lookup */
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
    return url.trim();
  }
}

function getPicsKind(sourceFile?: string): PicsKind {
  const f = (sourceFile ?? "").toLowerCase().replace(/\\/g, "/");
  if (f.includes("culture") || f.includes("культура")) return "culture";
  if (f.includes("autos/")) return "autos";
  if (f.includes("tech/")) return "tech";
  return "main";
}

function getManifest(kind: PicsKind): Record<string, string> {
  return kind === "culture"
    ? (cultureManifest as Record<string, string>)
    : kind === "autos"
      ? (autosManifest as Record<string, string>)
      : kind === "tech"
        ? (techManifest as Record<string, string>)
        : (mainManifest as Record<string, string>);
}

function getFolderPrefix(kind: PicsKind): string {
  return kind === "culture"
    ? "Culture/"
    : kind === "autos"
      ? "Autos/"
      : kind === "tech"
        ? "Tech/"
        : "";
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

/** Strip accidental path separators so URLs stay `/history-pics/...` without `//` or `../`. */
function sanitizeManifestFilename(filename: string): string {
  return filename
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(Culture|Autos|Tech)\//i, "");
}

function buildBaseToFilenameIndex(
  manifest: Record<string, string>
): Map<string, string> {
  const byBase = new Map<string, string>();

  for (const filename of Object.values(manifest)) {
    const base = stripExt(filename);
    const existing = byBase.get(base);
    if (!existing) {
      byBase.set(base, filename);
      continue;
    }

    const existingExt = existing.slice(existing.lastIndexOf("."));
    const nextExt = filename.slice(filename.lastIndexOf("."));
    const existingRank = EXTENSIONS.indexOf(existingExt);
    const nextRank = EXTENSIONS.indexOf(nextExt);

    if (nextRank >= 0 && (existingRank < 0 || nextRank < existingRank)) {
      byBase.set(base, filename);
    }
  }

  return byBase;
}

const mainBaseToFilename = buildBaseToFilenameIndex(
  mainManifest as Record<string, string>
);
const cultureBaseToFilename = buildBaseToFilenameIndex(
  cultureManifest as Record<string, string>
);
const autosBaseToFilename = buildBaseToFilenameIndex(
  autosManifest as Record<string, string>
);
const techBaseToFilename = buildBaseToFilenameIndex(
  techManifest as Record<string, string>
);

function getBaseToFilenameIndex(kind: PicsKind): Map<string, string> {
  return kind === "culture"
    ? cultureBaseToFilename
    : kind === "autos"
      ? autosBaseToFilename
      : kind === "tech"
        ? techBaseToFilename
        : mainBaseToFilename;
}

function buildServerUrl(kind: PicsKind, filename: string): string | undefined {
  const safe = sanitizeManifestFilename(filename);
  if (!safe) return undefined;
  const prefix = getFolderPrefix(kind);
  return `${BASE}/${prefix}${safe}`;
}

export function getLocalImageUrl(event: {
  date: string;
  url: string;
  sourceFile?: string;
  enWikiUrl?: string;
}): string | undefined {
  const kind = getPicsKind(event.sourceFile);
  const manifest = getManifest(kind);
  const baseToFilename = getBaseToFilenameIndex(kind);

  const urlCandidates: string[] = [];
  for (const u of [event.url, event.enWikiUrl]) {
    if (typeof u !== "string") continue;
    const t = u.trim();
    if (!t.startsWith("http")) continue;
    urlCandidates.push(t);
  }

  const seenNorm = new Set<string>();
  for (const u of urlCandidates) {
    const norm = normalizeUrl(u);
    if (seenNorm.has(norm)) continue;
    seenNorm.add(norm);

    const key = `${event.date}|${norm}`;
    const filename = manifest[key];
    if (filename) {
      const resolved = buildServerUrl(kind, filename);
      if (resolved) return resolved;
    }
  }

 // fallback: прямой перебор файлов по дате
for (const ext of EXTENSIONS) {
  const url = buildServerUrl(kind, `${event.date}${ext}`);
  if (url) {
    return url;
  }
}

  return undefined;
}
