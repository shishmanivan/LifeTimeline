import {
  bulkUpsertHistoricalEvents,
  deleteHistoricalEventsByIds,
  getAllHistoricalEvents,
  getHistoricalEvent,
} from "../db";
import { assignHistoricalLanes } from "./laneAssignment";
import manifest from "./HistoryPics/_manifest.json";
import { generatePreviewBlob } from "../imagePreview";
import type { HistoricalEvent } from "./types";

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_CONCURRENCY = 4;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ENRICH_VERSION = 1;

async function sha1(str: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(str);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ParsedRow = {
  date: string;
  url: string;
  image: string;
  title: string;
  lang: string;
  sourceLine: number;
  /** New format: en_url for ID, ru_url for display */
  ruUrl?: string;
};

/** New format: date, en_url, image, en_title, ru_title, ru_url */
function isNewFormat(headers: string[]): boolean {
  return headers.includes("en_url");
}

export function parseTsv(
  raw: string,
  fileName: string
): { rows: ParsedRow[]; errors: number } {
  const lines = raw.split(/\r?\n/);
  let errors = 0;
  if (lines.length < 2) return { rows: [], errors: 0 };

  const headerLine = lines[0];
  const headers = headerLine.split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => {
    const i = headers.indexOf(name);
    if (i < 0) return -1;
    return i;
  };
  const dateIdx = idx("date");
  const urlIdx = idx("url");
  const enUrlIdx = idx("en_url");
  const imageIdx = idx("image");
  const titleIdx = idx("title");
  const enTitleIdx = idx("en_title");
  const ruTitleIdx = idx("ru_title");
  const ruUrlIdx = idx("ru_url");
  const langIdx = idx("lang");

  const newFmt = isNewFormat(headers);
  const hasUrl = urlIdx >= 0 || (newFmt && enUrlIdx >= 0);
  if (dateIdx < 0 || !hasUrl) {
    console.warn(`[history] ${fileName}: missing required columns date, url/en_url`);
    return { rows: [], errors: 1 };
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;

    const cells = line.split("\t");
    const get = (col: number) => (col >= 0 && col < cells.length ? cells[col].trim() : "");

    const date = get(dateIdx);
    let url: string;
    let title: string;
    let lang: string;
    let ruUrl: string | undefined;

    if (newFmt) {
      url = get(enUrlIdx);
      ruUrl = ruUrlIdx >= 0 ? get(ruUrlIdx) : undefined;
      title = ruTitleIdx >= 0 ? get(ruTitleIdx) : get(enTitleIdx);
      lang = "ru";
    } else {
      url = get(urlIdx);
      title = titleIdx >= 0 ? get(titleIdx) : "";
      lang = langIdx >= 0 ? get(langIdx) : "en";
      ruUrl = ruUrlIdx >= 0 ? get(ruUrlIdx) : undefined;
    }

    const image = imageIdx >= 0 ? get(imageIdx) : "";

    if (!DATE_REGEX.test(date)) {
      console.warn(`[history] ${fileName}:${i + 1}: invalid date (expected YYYY-MM-DD): ${date}`);
      errors++;
      continue;
    }
    if (!url.startsWith("http")) {
      console.warn(`[history] ${fileName}:${i + 1}: url/en_url must start with http: ${url}`);
      errors++;
      continue;
    }

    rows.push({ date, url, image, title, lang, sourceLine: i + 1, ruUrl });
  }
  return { rows, errors };
}

type WikiPageData = {
  title: string;
  extract?: string;
  thumbnailUrl?: string;
  ruUrl?: string;
};

async function fetchWikiThumbnail(url: string): Promise<WikiPageData> {
  const title = decodeURIComponent(url.split("/wiki/")[1] ?? "");
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "pageimages|extracts|langlinks",
    format: "json",
    origin: "*",
    piprop: "thumbnail",
    pithumbsize: "640",
    exintro: "1",
    explaintext: "1",
    exlimit: "1",
    lllang: "ru",
    llprop: "url",
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  const json = await res.json();
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0] as Record<string, unknown> | undefined;
  if (!page || page.missing !== undefined) {
    return { title: title.replace(/_/g, " ") };
  }
  const pageTitle = (page.title as string) ?? title;
  const extract = (page.extract as string) ?? "";
  const thumb = page.thumbnail as { source?: string } | undefined;
  const langlinks = page.langlinks as { lang: string; url?: string }[] | undefined;
  const ruLink = langlinks?.find((ll) => ll.lang === "ru");
  const ruUrl = ruLink?.url;
  return { title: pageTitle, extract, thumbnailUrl: thumb?.source, ruUrl };
}

async function downloadBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.blob();
}

async function fetchWithLimit<T>(
  queue: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: (T | undefined)[] = new Array(queue.length);
  let idx = 0;
  const run = async (): Promise<void> => {
    while (idx < queue.length) {
      const i = idx++;
      const fn = queue[i];
      if (!fn) break;
      try {
        results[i] = await fn();
      } catch {
        results[i] = undefined;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, () => run())
  );
  return results as T[];
}

function needsEnrich(existing: HistoricalEvent | null, row: ParsedRow): boolean {
  if (!existing) return true;
  const titleMatch = (row.title.trim() || existing.title) === existing.title;
  const langMatch = existing.lang === row.lang;
  const imageMatch = !row.image.trim() || existing.thumbnailUrl === row.image.trim();
  const urlMatch = (row.ruUrl || row.url) === existing.url;
  return !titleMatch || !langMatch || !imageMatch || !urlMatch;
}

const ingestLock = { running: false, promise: null as Promise<void> | null };

export async function runHistoryIngest(): Promise<void> {
  if (ingestLock.running && ingestLock.promise) return ingestLock.promise;

  const p = (async () => {
    ingestLock.running = true;
    try {
      await runHistoryIngestInternal();
    } finally {
      ingestLock.running = false;
      ingestLock.promise = null;
    }
  })();
  ingestLock.promise = p;
  return p;
}

async function runHistoryIngestInternal(): Promise<void> {
  const modules = import.meta.glob<string>("./sources/*.tsv", {
    query: "?raw",
    import: "default",
  });

  let totalEvents = 0;
  let totalErrors = 0;
  const allFromDb = await getAllHistoricalEvents();

  const mainSourcedIds = allFromDb
    .filter((e) => e.sourceFile === "Main.tsv")
    .map((e) => e.id);
  if (mainSourcedIds.length > 0) {
    await deleteHistoricalEventsByIds(mainSourcedIds);
    if (import.meta.env.DEV) {
      console.log(`[history] Removed ${mainSourcedIds.length} events from Main.tsv (data only from year files)`);
    }
  }

  for (const [path, loader] of Object.entries(modules)) {
    const fileName = path.split("/").pop() ?? path;
    if (fileName === "Main.tsv") continue;
    let raw: string;
    try {
      raw = await loader();
    } catch (e) {
      console.warn(`[history] Failed to load ${fileName}:`, e);
      totalErrors++;
      continue;
    }

    const { rows, errors } = parseTsv(raw, fileName);
    totalErrors += errors;

    const currentIds = new Set<string>();
    for (const row of rows) {
      const idStr = `${row.date}|${row.url}`;
      currentIds.add(await sha1(idStr));
    }

    const toRemove = allFromDb.filter(
      (e) => e.sourceFile === fileName && !currentIds.has(e.id)
    );
    if (toRemove.length > 0) {
      await deleteHistoricalEventsByIds(toRemove.map((e) => e.id));
      if (import.meta.env.DEV) {
        console.log(`[history] Removed ${toRemove.length} events from ${fileName}`);
      }
    }

    const events: HistoricalEvent[] = [];
    const tasks = rows.map((row) => async (): Promise<HistoricalEvent | null> => {
      const idStr = `${row.date}|${row.url}`;
      const id = await sha1(idStr);

      const existing = await getHistoricalEvent(id);
      if (!needsEnrich(existing, row)) return null;

      const hasLocalPic = (manifest as Record<string, string>)[idStr] != null;
      let thumbnailUrl = row.image ? row.image.trim() : undefined;
      let title = row.title.trim() || undefined;
      let summary: string | undefined;

      let ruUrl: string | undefined = row.ruUrl || undefined;
      if (row.url.includes("wikipedia.org")) {
        try {
          const wiki = await fetchWikiThumbnail(row.url);
          if (!title) title = wiki.title;
          summary = wiki.extract?.slice(0, 300);
          if (!thumbnailUrl && !hasLocalPic) thumbnailUrl = wiki.thumbnailUrl;
          if (!ruUrl) ruUrl = wiki.ruUrl;
        } catch {
          /* leave empty */
        }
      }

      let previewBlob: Blob | undefined;
      if (thumbnailUrl && !hasLocalPic) {
        try {
          const fullBlob = await downloadBlob(thumbnailUrl);
          previewBlob = await generatePreviewBlob(fullBlob, 320);
        } catch {
          /* leave empty */
        }
      }
      if (hasLocalPic) {
        thumbnailUrl = undefined;
        previewBlob = undefined;
      }

      const displayUrl = row.ruUrl || row.url;
      const ev: HistoricalEvent = {
        id,
        date: row.date,
        url: displayUrl,
        title: title ?? row.url,
        lang: row.lang,
        thumbnailUrl,
        previewBlob,
        tags: [],
        sourceFile: fileName,
        sourceLine: row.sourceLine,
        updatedAt: new Date().toISOString(),
        enrichVersion: ENRICH_VERSION,
        summary,
        importance: 3,
        ruUrl: displayUrl.startsWith("https://ru.wikipedia") ? undefined : ruUrl,
      };
      return ev;
    });

    const results = await fetchWithLimit<HistoricalEvent | null>(
      tasks,
      WIKI_CONCURRENCY
    );
    const toUpsert = results.filter((e): e is HistoricalEvent => e != null);
    if (toUpsert.length > 0) {
      await bulkUpsertHistoricalEvents(toUpsert);
      totalEvents += toUpsert.length;
    }

    if (import.meta.env.DEV && (toUpsert.length > 0 || errors > 0)) {
      console.log(
        `[history] Ingested ${fileName}: ${toUpsert.length} events, errors: ${errors}`
      );
    }
  }

  // Assign lanes once for ALL events and persist — never recalculate at display time
  const allEvents = await getAllHistoricalEvents();
  if (allEvents.length > 0) {
    const withLanes = assignHistoricalLanes(allEvents);
    await bulkUpsertHistoricalEvents(withLanes);
    if (import.meta.env.DEV) {
      console.log(`[history] Assigned laneIndex to ${withLanes.length} events`);
    }
  }

  if (import.meta.env.DEV && (totalEvents > 0 || totalErrors > 0)) {
    console.log(
      `[history] Ingested total: ${totalEvents} events, errors: ${totalErrors}`
    );
  }
}
