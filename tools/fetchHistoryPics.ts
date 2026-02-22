#!/usr/bin/env node
/**
 * Fetch historical event images from Wikipedia and save to HistoryPics.
 * Idempotent: re-run does not re-download or rename.
 *
 * Usage: npm run history:pics [--include-manual]
 *   --include-manual  Also cache images from row.image when it's an http(s) URL
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCES_DIR = path.join(PROJECT_ROOT, "src", "history", "sources");
const PICS_DIR = path.join(PROJECT_ROOT, "src", "history", "HistoryPics");
const MANIFEST_PATH = path.join(PICS_DIR, "_manifest.json");
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

type Manifest = Record<string, string>;

function parseTsv(raw: string, fileName: string): { date: string; url: string; image: string }[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const dateIdx = idx("date");
  const urlIdx = idx("url");
  const imageIdx = idx("image");

  if (dateIdx < 0 || urlIdx < 0) return [];

  const rows: { date: string; url: string; image: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cells = line.split("\t");
    const get = (col: number) => (col >= 0 && col < cells.length ? cells[col].trim() : "");
    const date = get(dateIdx);
    const url = get(urlIdx);
    const image = imageIdx >= 0 ? get(imageIdx) : "";

    if (!DATE_REGEX.test(date) || !url.startsWith("http")) continue;
    rows.push({ date, url, image });
  }
  return rows;
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
  const res = await fetch(`${WIKI_API}?${params}`);
  const json = (await res.json()) as { query?: { pages?: Record<string, { thumbnail?: { source?: string } }> } };
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  return page?.thumbnail?.source;
}

function eventKey(date: string, url: string): string {
  return `${date}|${url}`;
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".webp")) return ".webp";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return ".jpg";
    if (pathname.endsWith(".png")) return ".png";
  } catch {
    /* ignore */
  }
  return ".webp";
}

function getNextFilenameForDate(manifest: Manifest, date: string, ext = ".webp"): string {
  const used = new Set<string>();
  for (const fn of Object.values(manifest)) {
    if (fn && (fn.startsWith(`${date}.`) || fn.startsWith(`${date}_`))) {
      used.add(fn);
    }
  }
  const filesOnDisk = fs.readdirSync(PICS_DIR).filter((f) => f.startsWith(date) && f !== "_manifest.json");
  for (const f of filesOnDisk) used.add(f);

  const base = `${date}${ext}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${date}_${n}${ext}`)) n++;
  return `${date}_${n}${ext}`;
}

function isHttpUrl(s: string): boolean {
  const t = s.trim();
  return t.startsWith("http://") || t.startsWith("https://");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadAndSave(imageUrl: string, destPath: string): Promise<void> {
  const res = await fetch(imageUrl, { mode: "cors" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${imageUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
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
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr ?? new Error("Download failed");
}

async function main(): Promise<void> {
  const includeManual = process.argv.includes("--include-manual");

  if (!fs.existsSync(PICS_DIR)) {
    fs.mkdirSync(PICS_DIR, { recursive: true });
  }

  let manifest: Manifest = {};
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  }

  const tsvFiles = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".tsv"));
  const allRows: { date: string; url: string; image: string }[] = [];

  for (const file of tsvFiles) {
    const raw = fs.readFileSync(path.join(SOURCES_DIR, file), "utf-8");
    const rows = parseTsv(raw, file);
    allRows.push(...rows);
  }

  const stats = {
    totalEvents: allRows.length,
    downloaded: 0,
    downloadedManual: 0,
    hit: 0,
    skippedManual: 0,
    skippedNoWikiImage: 0,
    failed: 0,
  };
  const failedList: { key: string; url: string; error: string }[] = [];
  const skippedNoWikiList: { key: string; url: string }[] = [];

  let manifestChanged = false;

  for (const row of allRows) {
    const manualImage = row.image.trim();
    const hasManualImage = manualImage.length > 0;
    const key = eventKey(row.date, row.url);

    if (hasManualImage) {
      if (includeManual && isHttpUrl(manualImage)) {
        const existing = manifest[key];
        const filePath = existing ? path.join(PICS_DIR, existing) : null;
        if (existing && filePath && fs.existsSync(filePath)) {
          console.log(`[historypics] HIT ${key} -> ${existing}`);
          stats.hit++;
          continue;
        }
        const ext = getExtensionFromUrl(manualImage);
        const filename = existing ?? getNextFilenameForDate(manifest, row.date, ext);
        const destPath = path.join(PICS_DIR, filename);
        try {
          await downloadWithRetry(manualImage, destPath);
          manifest[key] = filename;
          manifestChanged = true;
          stats.downloadedManual++;
          console.log(`[historypics] DOWNLOADED_MANUAL ${key} -> ${filename}`);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.log(`[historypics] FAIL_DOWNLOAD ${key}: ${errMsg}`);
          stats.failed++;
          failedList.push({ key, url: row.url, error: errMsg });
        }
        continue;
      }
      console.log(`[historypics] SKIP_MANUAL_IMAGE ${key}`);
      stats.skippedManual++;
      continue;
    }

    const existing = manifest[key];
    const filePath = existing ? path.join(PICS_DIR, existing) : null;

    if (existing && filePath && fs.existsSync(filePath)) {
      console.log(`[historypics] HIT ${key} -> ${existing}`);
      stats.hit++;
      continue;
    }

    const thumbnailUrl = await fetchWikiThumbnail(row.url);
    if (!thumbnailUrl) {
      console.log(`[historypics] SKIP_NO_WIKI_IMAGE ${key}`);
      stats.skippedNoWikiImage++;
      skippedNoWikiList.push({ key, url: row.url });
      continue;
    }

    const filename = existing ?? getNextFilenameForDate(manifest, row.date);
    const destPath = path.join(PICS_DIR, filename);

    try {
      await downloadWithRetry(thumbnailUrl, destPath);
      manifest[key] = filename;
      manifestChanged = true;
      stats.downloaded++;
      console.log(`[historypics] saved ${filename}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[historypics] FAIL_DOWNLOAD ${key}: ${errMsg}`);
      stats.failed++;
      failedList.push({ key, url: row.url, error: errMsg });
    }
  }

  if (manifestChanged) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  console.log("\n--- Summary ---");
  console.log(`totalEvents: ${stats.totalEvents}`);
  console.log(`downloaded: ${stats.downloaded}`);
  console.log(`downloadedManual: ${stats.downloadedManual}`);
  console.log(`hit: ${stats.hit}`);
  console.log(`skippedManual: ${stats.skippedManual}`);
  console.log(`skippedNoWikiImage: ${stats.skippedNoWikiImage}`);
  console.log(`failed: ${stats.failed}`);

  if (failedList.length > 0) {
    console.log("\n--- Failed (eventKey + url) ---");
    for (const { key, url, error } of failedList) {
      console.log(`${key} | ${url} | ${error}`);
    }
  }

  if (skippedNoWikiList.length > 0) {
    console.log("\n--- SkippedNoWikiImage (eventKey + url) ---");
    for (const { key, url } of skippedNoWikiList) {
      console.log(`${key} | ${url}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
