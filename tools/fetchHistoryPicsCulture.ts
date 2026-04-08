#!/usr/bin/env node
/**
 * Fetch images for Culture TSV sources into HistoryPics/Culture.
 * Downloads only events that are not already present in Culture manifest/folder.
 *
 * Usage: npm run history:pics:culture
 *        npm run history:pics:culture -- 198c.tsv   # only this file
 *        npm run history:pics:culture -- 199c.tsv 1995-07-01  # file + min date (YYYY-MM-DD)
 *        npm run history:pics:culture -- 189c.tsv --from-line 22  # from 1-based line (header = line 1)
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
const SOURCES_DIR = path.join(PROJECT_ROOT, "src", "history", "sources", "Culture");
const PICS_DIR = path.join(PROJECT_ROOT, "src", "history", "HistoryPics", "Culture");
const MANIFEST_PATH = path.join(PICS_DIR, "_manifest.json");
const WIKI_API = "https://en.wikipedia.org/w/api.php";
/** https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy */
const WIKI_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "timeline-mvp/0.0.1 (Culture history thumbnails; private project)",
  Accept: "application/json",
};
/** YYYY-MM-DD or YYYY-MM-DD_2, _3… for same-day events (matches ingestHistory) */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(_\d+)?$/;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
/** Default 2.8s between Wikipedia calls; override: HISTORY_PICS_REQUEST_DELAY_MS */
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
      /* keep as-is if decode fails */
    }
    pathname = pathname.replace(/\/+$/, "");
    return `${u.origin}${pathname}`;
  } catch {
    return url;
  }
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

  const fromLine = options?.fromPhysicalLine;
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const physicalLine = i + 1;
    if (fromLine != null && physicalLine < fromLine) continue;

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

function eventKey(date: string, url: string): string {
  return `${date}|${normalizeUrl(url)}`;
}

function isHttpUrl(value: string): boolean {
  const t = value.trim();
  return t.startsWith("http://") || t.startsWith("https://");
}

function filenameForDate(date: string, _ext = ".jpg"): string {
  if (!/^\d{4}-\d{2}-\d{2}(_\d+)?$/.test(date)) {
    throw new Error(`BUG: invalid date for filename: ${date}`);
  }
  return `${date}.jpg`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const filename = path.basename(destPath);
  if (!/^\d{4}-\d{2}-\d{2}(_\d+)?\.[a-z0-9]+$/i.test(filename)) {
    throw new Error(`BUG: unexpected image filename: ${filename}`);
  }
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
          console.log(
            `[historypics:culture] Download 429, waiting ${waitMs / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`
          );
        }
        await sleep(waitMs);
      }
    }
  }
  throw lastErr ?? new Error("Download failed");
}

function collectTsvFiles(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectTsvFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".tsv")) {
      out.push(rel);
    }
  }
  return out;
}

/** Extra CLI args after the optional file filter (argv[2]). */
function parseScopeArgs(): { fromDate?: string; fromPhysicalLine?: number } {
  const args = process.argv.slice(3);
  let fromDate: string | undefined;
  let fromPhysicalLine: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      fromDate = a;
      continue;
    }
    if (a === "--from-line" && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isFinite(n) && n >= 1) fromPhysicalLine = n;
      i++;
      continue;
    }
    const m = /^--from-line=(\d+)$/.exec(a);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) fromPhysicalLine = n;
    }
  }
  return { fromDate, fromPhysicalLine };
}

function loadManifest(filePath: string): Manifest {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Manifest;
}

async function main(): Promise<void> {
  if (!fs.existsSync(PICS_DIR)) {
    fs.mkdirSync(PICS_DIR, { recursive: true });
  }

  const manifest = loadManifest(MANIFEST_PATH);
  let manifestChanged = false;

  for (const [key, filename] of Object.entries(manifest)) {
    if (!filename || !fs.existsSync(path.join(PICS_DIR, filename))) {
      delete manifest[key];
      manifestChanged = true;
    }
  }

  let tsvFiles = collectTsvFiles(SOURCES_DIR);
  const fileFilter = process.argv[2];
  if (fileFilter) {
    tsvFiles = tsvFiles.filter((f) => f.endsWith(fileFilter) || path.basename(f) === fileFilter);
    if (tsvFiles.length === 0) {
      console.error(`[historypics:culture] No TSV matching: ${fileFilter}`);
      process.exit(1);
    }
    console.log(`[historypics:culture] Filter: ${fileFilter} (${tsvFiles.length} file(s))\n`);
  }
  const { fromDate: fromDateArg, fromPhysicalLine } = parseScopeArgs();
  const parseOpts = fromPhysicalLine != null ? { fromPhysicalLine } : undefined;
  const allRows: ParsedRow[] = [];
  for (const file of tsvFiles) {
    const raw = fs.readFileSync(path.join(SOURCES_DIR, file), "utf-8");
    allRows.push(...parseTsv(raw, parseOpts));
  }
  if (fromPhysicalLine != null) {
    console.log(
      `[historypics:culture] From physical line >= ${fromPhysicalLine} in each TSV (${allRows.length} raw row(s) before dedup)\n`
    );
  }

  const deduped = new Map<string, ParsedRow>();
  for (const row of allRows) {
    const key = eventKey(row.date, row.url);
    const prev = deduped.get(key);
    if (!prev || (row.image.trim() && !prev.image.trim())) {
      deduped.set(key, row);
    }
  }
  let rows = Array.from(deduped.values());

  if (fromDateArg) {
    const base = (d: string) => d.replace(/_\d+$/, "");
    rows = rows.filter((r) => base(r.date) >= fromDateArg);
    console.log(`[historypics:culture] From date >= ${fromDateArg} (${rows.length} event(s) in scope)\n`);
  }

  const usedDates = new Set<string>();
  /** Base date key for collision: full YYYY-MM-DD or YYYY-MM-DD_N before extension */
  const datePrefixFromFilename = (fn: string): string | undefined => {
    const m = fn.match(/^(\d{4}-\d{2}-\d{2}(?:_\d+)?)\./);
    return m?.[1];
  };
  for (const filename of Object.values(manifest)) {
    const p = datePrefixFromFilename(filename);
    if (p) usedDates.add(p);
  }
  for (const file of fs.readdirSync(PICS_DIR)) {
    if (file === "_manifest.json") continue;
    const p = datePrefixFromFilename(file);
    if (p) usedDates.add(p);
  }

  const stats = {
    totalEvents: rows.length,
    downloaded: 0,
    downloadedManual: 0,
    hit: 0,
    skippedDateCollision: 0,
    skippedManual: 0,
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
      usedDates.add(row.date);
      stats.hit++;
      continue;
    }

    const manualImage = row.image.trim();
    const manualIsSvg =
      manualImage.length > 0 &&
      (manualImage.toLowerCase().endsWith(".svg") ||
        (manualImage.startsWith("http") && getExtensionFromUrl(manualImage) === ".svg"));
    const shouldUpgradeToSvg =
      manualIsSvg &&
      fs.readdirSync(PICS_DIR).some(
        (f) => f.startsWith(row.date) && f !== "_manifest.json" && /\.(webp|jpg|jpeg|jfif|png)$/i.test(f)
      );

    if (usedDates.has(row.date) && !shouldUpgradeToSvg) {
      stats.skippedDateCollision++;
      continue;
    }

    if (manualImage) {
      let imageUrl: string | undefined;
      if (isHttpUrl(manualImage)) {
        imageUrl = manualImage;
      } else {
        if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
        imageUrl = await resolveImageUrl(manualImage);
      }

      if (!imageUrl) {
        console.log(`[historypics:culture] SKIP_MANUAL_IMAGE ${key}`);
        stats.skippedManual++;
        continue;
      }

      const ext = ".jpg";
      const filename = filenameForDate(row.date, ext);
      const destPath = path.join(PICS_DIR, filename);

      if (ext === ".svg" && usedDates.has(row.date)) {
        const rasterFiles = fs
          .readdirSync(PICS_DIR)
          .filter((f) => f.startsWith(row.date) && /\.(webp|jpg|jpeg|jfif|png)$/i.test(f));
        for (const file of rasterFiles) {
          fs.unlinkSync(path.join(PICS_DIR, file));
          usedDates.delete(row.date);
        }
      }

      if (fs.existsSync(destPath)) {
        manifest[key] = filename;
        usedDates.add(row.date);
        manifestChanged = true;
        stats.hit++;
        continue;
      }

      try {
        if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
        await downloadWithRetry(imageUrl, destPath);
        manifest[key] = filename;
        usedDates.add(row.date);
        manifestChanged = true;
        stats.downloadedManual++;
        console.log(`[historypics:culture] DOWNLOADED_MANUAL ${key} -> ${filename}`);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.log(`[historypics:culture] FAIL_DOWNLOAD ${key}: ${errMsg}`);
        stats.failed++;
      }
      continue;
    }

    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    let thumbnailUrl: string | undefined;
    let wikiFetchError = false;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        thumbnailUrl = await fetchWikiThumbnail(row.url);
        break;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("429") && attempt < RETRY_ATTEMPTS) {
          console.log(
            `[historypics:culture] RATE_LIMITED, waiting ${RATE_LIMIT_WAIT_MS / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`
          );
          await sleep(RATE_LIMIT_WAIT_MS);
        } else {
          console.log(`[historypics:culture] FAIL_FETCH ${key}: ${errMsg}`);
          stats.failed++;
          wikiFetchError = true;
        }
      }
    }

    if (!thumbnailUrl) {
      if (wikiFetchError) continue;
      console.log(`[historypics:culture] SKIP_NO_WIKI_IMAGE ${key}`);
      stats.skippedNoWikiImage++;
      continue;
    }

    const existingByDateAfterFetch = findBestExistingFileByDate(PICS_DIR, row.date);
    if (existingByDateAfterFetch) {
      manifest[key] = existingByDateAfterFetch;
      usedDates.add(row.date);
      manifestChanged = true;
      stats.hit++;
      continue;
    }

    try {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      const filename = filenameForDate(row.date, ".jpg");
      const destPath = path.join(PICS_DIR, filename);
      if (fs.existsSync(destPath)) {
        manifest[key] = filename;
        usedDates.add(row.date);
        manifestChanged = true;
        stats.hit++;
        continue;
      }
      await downloadWithRetry(thumbnailUrl, destPath);
      manifest[key] = filename;
      usedDates.add(row.date);
      manifestChanged = true;
      stats.downloaded++;
      console.log(`[historypics:culture] saved ${filename}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[historypics:culture] FAIL_DOWNLOAD ${key}: ${errMsg}`);
      stats.failed++;
    }
  }

  if (manifestChanged) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  console.log("\n--- Culture Summary ---");
  console.log(`totalEvents: ${stats.totalEvents}`);
  console.log(`downloaded: ${stats.downloaded}`);
  console.log(`downloadedManual: ${stats.downloadedManual}`);
  console.log(`hit: ${stats.hit}`);
  console.log(`skippedDateCollision: ${stats.skippedDateCollision}`);
  console.log(`skippedManual: ${stats.skippedManual}`);
  console.log(`skippedNoWikiImage: ${stats.skippedNoWikiImage}`);
  console.log(`failed: ${stats.failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
