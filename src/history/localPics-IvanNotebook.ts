/**
 * Local image cache for historical events.
 * Priority: HistoryPics (manifest) > IndexedDB previewBlob > Wikipedia thumbnailUrl
 */

import manifest from "./HistoryPics/_manifest.json";

const picModules = import.meta.glob<string>(
  "./HistoryPics/*.{png,jpg,jpeg,webp,avif}",
  { eager: true, import: "default" }
);

const filenameToUrl = new Map<string, string>();
for (const [path, url] of Object.entries(picModules)) {
  const filename = path.split("/").pop() ?? path;
  filenameToUrl.set(filename, url);
}

const EXTENSIONS = [".webp", ".jpg", ".jpeg", ".png", ".avif"];

function tryByBaseName(base: string): string | undefined {
  for (const ext of EXTENSIONS) {
    const url = filenameToUrl.get(base + ext);
    if (url) return url;
  }
  return undefined;
}

export function getLocalImageUrl(event: {
  date: string;
  url: string;
}): string | undefined {
  const key = `${event.date}|${event.url}`;
  const filename = (manifest as Record<string, string>)[key];
  if (!filename) return undefined;
  const base = filename.includes(".") ? filename.replace(/\.[^.]+$/, "") : filename;
  return tryByBaseName(base);
}
