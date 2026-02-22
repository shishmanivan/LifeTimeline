/**
 * Local image cache for historical events.
 * Priority: HistoryPics (manifest) > IndexedDB previewBlob > Wikipedia thumbnailUrl
 */

import manifest from "./HistoryPics/_manifest.json";

const picModules = import.meta.glob<string>(
  "./HistoryPics/*.{png,jpg,jpeg,webp}",
  { eager: true, import: "default" }
);

const filenameToUrl = new Map<string, string>();
for (const [path, url] of Object.entries(picModules)) {
  const filename = path.split("/").pop() ?? path;
  filenameToUrl.set(filename, url);
}

export function getLocalImageUrl(event: {
  date: string;
  url: string;
}): string | undefined {
  const key = `${event.date}|${event.url}`;
  const filename = (manifest as Record<string, string>)[key];
  if (!filename) return undefined;
  return filenameToUrl.get(filename);
}
