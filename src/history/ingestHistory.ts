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
};

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
  const imageIdx = idx("image");
  const titleIdx = idx("title");
  const langIdx = idx("lang");

  if (dateIdx < 0 || urlIdx < 0) {
    console.warn(`[history] ${fileName}: missing required columns date, url`);
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
    const url = get(urlIdx);
    const image = imageIdx >= 0 ? get(imageIdx) : "";
    const title = titleIdx >= 0 ? get(titleIdx) : "";
    const lang = langIdx >= 0 ? get(langIdx) : "en";

    if (!DATE_REGEX.test(date)) {
      console.warn(`[history] ${fileName}:${i + 1}: invalid date (expected YYYY-MM-DD): ${date}`);
      errors++;
      continue;
    }
    if (!url.startsWith("http")) {
      console.warn(`[history] ${fileName}:${i + 1}: url must start with http: ${url}`);
      errors++;
      continue;
    }

    rows.push({ date, url, image, title, lang, sourceLine: i + 1 });
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
  return !titleMatch || !langMatch || !imageMatch;
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

  for (const [path, loader] of Object.entries(modules)) {
    const fileName = path.split("/").pop() ?? path;
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
      const id = await sha1(`${row.date}|${row.url}`);
      currentIds.add(id);
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

      let ruUrl: string | undefined;
      if (row.url.includes("wikipedia.org")) {
        try {
          const wiki = await fetchWikiThumbnail(row.url);
          if (!title) title = wiki.title;
          summary = wiki.extract?.slice(0, 300);
          if (!thumbnailUrl && !hasLocalPic) thumbnailUrl = wiki.thumbnailUrl;
          ruUrl = wiki.ruUrl;
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

      const ev: HistoricalEvent = {
        id,
        date: row.date,
        url: row.url,
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
        ruUrl,
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
