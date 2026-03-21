#!/usr/bin/env node
/**
 * Fetch images for a chunk of Culture TSV — from a start row, limited count.
 * Avoids processing the entire file (rate limits).
 *
 * Usage: npm run history:pics:culture:chunk
 * Start: 2022-03-27 CODA, limit: 30 rows
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CULTURE_FILE = path.join(PROJECT_ROOT, "src", "history", "sources", "Culture", "21с.tsv");
const PICS_DIR = path.join(PROJECT_ROOT, "src", "history", "HistoryPics", "Culture");
const MANIFEST_PATH = path.join(PICS_DIR, "_manifest.json");
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(_\d+)?$/;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const REQUEST_DELAY_MS = 1200;
const RATE_LIMIT_WAIT_MS = 90_000;

/** Start from 2021-09-03 Dune row, take up to this many rows */
const MAX_ROWS = 30;

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

function parseTsv(raw: string): ParsedRow[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const dateIdx = idx("date");
  const enUrlIdx = idx("en_url");
  const imageIdx = idx("image");
  if (dateIdx < 0 || enUrlIdx < 0) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cells = line.split("\t");
    const get = (col: number) => (col >= 0 && col < cells.length ? cells[col].trim() : "");
    const date = get(dateIdx);
    const url = get(enUrlIdx);
    const image = imageIdx >= 0 ? get(imageIdx) : "";
    if (!DATE_REGEX.test(date) || !url.startsWith("http")) continue;
    rows.push({ date, url: normalizeUrl(url), image });
  }
  return rows;
}

function eventKey(date: string, url: string): string {
  return `${date}|${normalizeUrl(url)}`;
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".webp")) return ".webp";
    if (pathname.endsWith(".jfif")) return ".jfif";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return ".jpg";
    if (pathname.endsWith(".png")) return ".png";
    if (pathname.endsWith(".svg")) return ".svg";
  } catch {
    /* ignore */
  }
  return ".webp";
}

function filenameForDate(date: string, ext = ".webp"): string {
  const name = `${date}${ext}`;
  if (/_[234]\b/.test(name)) throw new Error(`BUG: filename must not contain _2/_3/_4: ${name}`);
  return name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  if (res.status === 429) throw new Error("Rate limited (429)");
  const text = await res.text();
  let json: { query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string } }> } };
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
      { headers: { Accept: "application/json" } }
    );
    if (restRes.ok) {
      const rest = (await restRes.json()) as { thumbnail?: { source?: string }; originalimage?: { source?: string } };
      thumbnailUrl = rest.thumbnail?.source ?? rest.originalimage?.source;
    }
  }
  return thumbnailUrl;
}

async function downloadWithRetry(imageUrl: string, destPath: string): Promise<void> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(imageUrl, { mode: "cors" });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buffer, { flag: "wx" });
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < RETRY_ATTEMPTS) {
        const is429 = lastErr.message.includes("429");
        const waitMs = is429 ? RATE_LIMIT_WAIT_MS : RETRY_DELAY_MS;
        if (is429) console.log(`[culture-chunk] 429, waiting ${waitMs / 1000}s`);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr ?? new Error("Download failed");
}

async function main(): Promise<void> {
  console.log("[culture-chunk] OneDrive: pause sync before running.");
  console.log(`[culture-chunk] Start: 2021-09-03 Dune, limit: ${MAX_ROWS} rows\n`);

  if (!fs.existsSync(PICS_DIR)) {
    fs.mkdirSync(PICS_DIR, { recursive: true });
  }

  const raw = fs.readFileSync(CULTURE_FILE, "utf-8");
  const allRows = parseTsv(raw);

  const startIdx = allRows.findIndex(
    (r) => r.date === "2021-09-03" && r.url.includes("Dune_(2021")
  );
  if (startIdx < 0) {
    console.error("[culture-chunk] Start row not found (2021-09-03 Dune)");
    process.exit(1);
  }

  const rows = allRows.slice(startIdx, startIdx + MAX_ROWS);
  console.log(`[culture-chunk] Processing ${rows.length} rows (from index ${startIdx})\n`);

  let manifest: Manifest = {};
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  }

  const usedDates = new Set<string>();
  for (const fn of Object.values(manifest)) {
    const m = fn.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) usedDates.add(m[1]);
  }
  for (const f of fs.readdirSync(PICS_DIR)) {
    if (f === "_manifest.json") continue;
    const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) usedDates.add(m[1]);
  }

  let manifestChanged = false;
  let downloaded = 0;
  let hit = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const key = eventKey(row.date, row.url);
    const existing = manifest[key];
    const filePath = existing ? path.join(PICS_DIR, existing) : null;
    if (existing && filePath && fs.existsSync(filePath)) {
      hit++;
      continue;
    }

    const hasFileByDate = fs.readdirSync(PICS_DIR).some(
      (f) => f !== "_manifest.json" && f.startsWith(`${row.date}.`)
    );
    if (hasFileByDate) {
      const match = fs.readdirSync(PICS_DIR).find((f) => f.startsWith(`${row.date}.`));
      if (match) {
        manifest[key] = match;
        manifestChanged = true;
        hit++;
      }
      continue;
    }

    if (row.image.trim()) {
      skipped++;
      continue;
    }

    if (usedDates.has(row.date)) {
      skipped++;
      continue;
    }

    try {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      const thumbnailUrl = await fetchWikiThumbnail(row.url);
      if (!thumbnailUrl) {
        console.log(`[culture-chunk] SKIP_NO_IMAGE ${key}`);
        skipped++;
        continue;
      }

      const ext = getExtensionFromUrl(thumbnailUrl);
      const filename = filenameForDate(row.date, ext);
      const destPath = path.join(PICS_DIR, filename);

      if (fs.existsSync(destPath)) {
        manifest[key] = filename;
        manifestChanged = true;
        hit++;
        continue;
      }

      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      await downloadWithRetry(thumbnailUrl, destPath);
      manifest[key] = filename;
      usedDates.add(row.date);
      manifestChanged = true;
      downloaded++;
      console.log(`[culture-chunk] DOWNLOADED ${row.date} ${row.url.split("/wiki/")[1] ?? ""} -> ${filename}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[culture-chunk] FAIL ${key}: ${errMsg}`);
      failed++;
    }
  }

  if (manifestChanged) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  console.log("\n--- Chunk Summary ---");
  console.log(`downloaded: ${downloaded}`);
  console.log(`hit: ${hit}`);
  console.log(`skipped: ${skipped}`);
  console.log(`failed: ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
