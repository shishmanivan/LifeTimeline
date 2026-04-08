#!/usr/bin/env node
/**
 * Fetch images for Tech TSV sources into HistoryPics/Tech.
 * Rule:
 * 1. If a local file for the event date already exists, reuse it.
 * 2. Else, if TSV `image` is provided, use it.
 * 3. Else, fetch the lead image from the English Wikipedia page.
 *
 * Usage: npm run history:pics:tech
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  fetchImageAsset,
  findBestExistingFileByDate,
  getExtensionFromUrl,
} from "./historyPicFileUtils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCES_DIR = path.join(PROJECT_ROOT, "src", "history", "sources", "Tech");
const PICS_DIR = path.join(PROJECT_ROOT, "src", "history", "HistoryPics", "Tech");
const MANIFEST_PATH = path.join(PICS_DIR, "_manifest.json");
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "timeline-mvp/0.0.1 (Tech history thumbnails; private project)",
  Accept: "application/json",
};
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(_\d+)?$/;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const REQUEST_DELAY_MS = (() => {
  const raw = process.env.HISTORY_PICS_REQUEST_DELAY_MS;
  if (raw === undefined || raw === "") return 2800;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(60_000, Math.max(500, n)) : 2800;
})();
const RATE_LIMIT_WAIT_MS = 90_000;

type Manifest = Record<string, string>;
type ParsedRow = { date: string; url: string; image: string };

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

function eventKey(date: string, url: string): string {
  return `${date}|${normalizeUrl(url)}`;
}

function parseScopeArgs(): { fileFilter?: string; fromPhysicalLine?: number } {
  const args = process.argv.slice(2);
  let fileFilter: string | undefined;
  let fromPhysicalLine: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from-line") {
      const next = args[i + 1];
      const value = Number(next);
      if (Number.isFinite(value) && value >= 2) {
        fromPhysicalLine = Math.floor(value);
        i++;
      }
      continue;
    }
    if (!arg.startsWith("--") && !fileFilter) {
      fileFilter = arg;
    }
  }

  return { fileFilter, fromPhysicalLine };
}

function parseTsv(raw: string, options?: { fromPhysicalLine?: number }): ParsedRow[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const dateIdx = idx("date");
  const urlIdx = idx("url");
  const enUrlIdx = idx("en_url");
  const imageIdx = idx("image");
  if (dateIdx < 0 || (urlIdx < 0 && enUrlIdx < 0)) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const physicalLine = i + 1;
    if (options?.fromPhysicalLine != null && physicalLine < options.fromPhysicalLine) continue;
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cells = line.split("\t");
    const get = (col: number) => (col >= 0 && col < cells.length ? cells[col].trim() : "");
    const date = get(dateIdx);
    const url = enUrlIdx >= 0 ? get(enUrlIdx) : get(urlIdx);
    const image = imageIdx >= 0 ? get(imageIdx) : "";
    if (!DATE_REGEX.test(date) || !url.startsWith("http")) continue;
    rows.push({ date, url: normalizeUrl(url), image });
  }
  return rows;
}

function filenameForDate(date: string, _ext = ".jpg"): string {
  if (!DATE_REGEX.test(date)) throw new Error(`Invalid date for filename: ${date}`);
  return `${date}.jpg`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
}

function findTsvFiles(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...findTsvFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".tsv")) out.push(rel);
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  const t = value.trim();
  return t.startsWith("http://") || t.startsWith("https://");
}

async function resolveImageUrl(input: string): Promise<string | undefined> {
  let fileTitle = input;
  if (input.startsWith("#/media/")) fileTitle = input.slice(8);
  else if (input.includes("/wiki/File:")) fileTitle = decodeURIComponent(input.split("/wiki/")[1] ?? "");
  else if (!input.startsWith("File:")) fileTitle = `File:${input}`;
  if (!fileTitle.startsWith("File:")) return undefined;

  const params = new URLSearchParams({
    action: "query",
    titles: fileTitle,
    prop: "imageinfo",
    iiprop: "url",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${WIKI_API}?${params}`, { headers: WIKI_FETCH_HEADERS });
  const json = (await res.json()) as {
    query?: { pages?: Record<string, { imageinfo?: { url?: string }[] }> };
  };
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url;
}

async function fetchWikiThumbnail(url: string): Promise<string | undefined> {
  const title = decodeURIComponent(url.split("/wiki/")[1] ?? "");
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "pageimages",
    format: "json",
    origin: "*",
    piprop: "thumbnail",
    pithumbsize: "640",
  });
  const res = await fetch(`${WIKI_API}?${params}`, { headers: WIKI_FETCH_HEADERS });
  if (res.status === 429) throw new Error("Rate limited (429)");
  const text = await res.text();
  let json: {
    query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string } }> };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON (${res.status}): ${text.slice(0, 80)}`);
  }
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  let thumbnailUrl = page?.thumbnail?.source;
  if (!thumbnailUrl && page?.title) {
    await sleep(REQUEST_DELAY_MS);
    const restRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
      { headers: WIKI_FETCH_HEADERS }
    );
    if (restRes.ok) {
      const rest = (await restRes.json()) as {
        thumbnail?: { source?: string };
        originalimage?: { source?: string };
      };
      thumbnailUrl = rest.thumbnail?.source ?? rest.originalimage?.source;
    }
  }
  return thumbnailUrl;
}

async function downloadAndSave(imageUrl: string, destPath: string): Promise<void> {
  if (fs.existsSync(destPath)) {
    throw new Error(`File exists, refusing to overwrite: ${destPath}`);
  }
  const { buffer } = await fetchImageAsset(imageUrl);
  fs.writeFileSync(destPath, buffer, { flag: "wx" });
}

async function downloadWithRetry(imageUrl: string, destPath: string): Promise<void> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await downloadAndSave(imageUrl, destPath);
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < RETRY_ATTEMPTS) {
        const is429 = lastErr.message.includes("429");
        const waitMs = is429 ? RATE_LIMIT_WAIT_MS : RETRY_DELAY_MS;
        if (is429) {
          console.log(`[historypics:tech] Download 429, waiting ${waitMs / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`);
        }
        await sleep(waitMs);
      }
    }
  }
  throw lastErr ?? new Error("Download failed");
}

async function main(): Promise<void> {
  if (!fs.existsSync(PICS_DIR)) {
    fs.mkdirSync(PICS_DIR, { recursive: true });
  }

  const scope = parseScopeArgs();
  const manifest = loadManifest();
  let manifestChanged = false;
  for (const [key, filename] of Object.entries(manifest)) {
    if (!filename || !fs.existsSync(path.join(PICS_DIR, filename))) {
      delete manifest[key];
      manifestChanged = true;
    }
  }

  const tsvFiles = findTsvFiles(SOURCES_DIR).filter((file) =>
    scope.fileFilter ? file === scope.fileFilter || file.endsWith(`/${scope.fileFilter}`) : true
  );
  const allRows: ParsedRow[] = [];
  for (const file of tsvFiles) {
    const raw = fs.readFileSync(path.join(SOURCES_DIR, file), "utf-8");
    allRows.push(...parseTsv(raw, { fromPhysicalLine: scope.fromPhysicalLine }));
  }

  const deduped = new Map<string, ParsedRow>();
  for (const row of allRows) {
    const key = eventKey(row.date, row.url);
    const prev = deduped.get(key);
    if (!prev || (row.image.trim() && !prev.image.trim())) deduped.set(key, row);
  }
  const rows = Array.from(deduped.values());

  const stats = {
    totalEvents: rows.length,
    downloaded: 0,
    downloadedManual: 0,
    hit: 0,
    skippedNoWikiImage: 0,
    failed: 0,
  };

  for (const row of rows) {
    const key = eventKey(row.date, row.url);
    const existing = manifest[key];
    if (existing && fs.existsSync(path.join(PICS_DIR, existing))) {
      stats.hit++;
      continue;
    }

    const existingByDate = findBestExistingFileByDate(PICS_DIR, row.date);
    if (existingByDate) {
      manifest[key] = existingByDate;
      manifestChanged = true;
      stats.hit++;
      continue;
    }

    let imageUrl: string | undefined;
    const manualImage = row.image.trim();
    if (manualImage) {
      if (isHttpUrl(manualImage)) imageUrl = manualImage;
      else {
        if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
        imageUrl = await resolveImageUrl(manualImage);
      }
    }

    let downloadKind: "manual" | "wiki" = "manual";
    if (!imageUrl) {
      downloadKind = "wiki";
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
          imageUrl = await fetchWikiThumbnail(row.url);
          break;
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          if (errMsg.includes("429") && attempt < RETRY_ATTEMPTS) {
            console.log(`[historypics:tech] RATE_LIMITED, waiting ${RATE_LIMIT_WAIT_MS / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`);
            await sleep(RATE_LIMIT_WAIT_MS);
          } else if (attempt === RETRY_ATTEMPTS) {
            console.log(`[historypics:tech] FAIL_FETCH ${key}: ${errMsg}`);
            stats.failed++;
          }
        }
      }
    }

    if (!imageUrl) {
      console.log(`[historypics:tech] SKIP_NO_WIKI_IMAGE ${key}`);
      stats.skippedNoWikiImage++;
      continue;
    }

    const filename = filenameForDate(row.date, ".jpg");
    const destPath = path.join(PICS_DIR, filename);

    if (fs.existsSync(destPath)) {
      manifest[key] = filename;
      manifestChanged = true;
      stats.hit++;
      continue;
    }

    try {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      const resolvedFilename = filenameForDate(row.date, ".jpg");
      const resolvedDestPath = path.join(PICS_DIR, resolvedFilename);
      if (fs.existsSync(resolvedDestPath)) {
        manifest[key] = resolvedFilename;
        manifestChanged = true;
        stats.hit++;
        continue;
      }
      await downloadWithRetry(imageUrl, resolvedDestPath);
      manifest[key] = resolvedFilename;
      manifestChanged = true;
      if (downloadKind === "manual") stats.downloadedManual++;
      else stats.downloaded++;
      console.log(`[historypics:tech] saved ${resolvedFilename}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[historypics:tech] FAIL_DOWNLOAD ${key}: ${errMsg}`);
      stats.failed++;
    }
  }

  if (manifestChanged) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  console.log("\n--- Tech Summary ---");
  console.log(`totalEvents: ${stats.totalEvents}`);
  console.log(`downloaded: ${stats.downloaded}`);
  console.log(`downloadedManual: ${stats.downloadedManual}`);
  console.log(`hit: ${stats.hit}`);
  console.log(`skippedNoWikiImage: ${stats.skippedNoWikiImage}`);
  console.log(`failed: ${stats.failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
