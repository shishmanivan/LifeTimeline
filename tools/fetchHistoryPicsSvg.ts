#!/usr/bin/env node
/**
 * Fetch ONLY SVG images from Wikipedia and save to HistoryPics.
 * Does not touch .webp, .jpg, .png etc. Only adds missing SVG files.
 *
 * Usage: npm run history:pics:svg
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
const REQUEST_DELAY_MS = 1200;
const RATE_LIMIT_WAIT_MS = 90_000;

type Manifest = Record<string, string>;

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

function parseTsv(raw: string, _fileName: string): { date: string; url: string; image: string }[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const dateIdx = idx("date");
  const urlIdx = idx("url");
  const enUrlIdx = idx("en_url");
  const imageIdx = idx("image");

  const hasUrl = urlIdx >= 0 || enUrlIdx >= 0;
  if (dateIdx < 0 || !hasUrl) return [];

  const rows: { date: string; url: string; image: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
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

function isSvgUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".svg");
  } catch {
    return false;
  }
}

/** Get original image URL (for SVG) from Wikipedia page. Uses original, not thumbnail. */
async function fetchWikiOriginalImage(url: string): Promise<string | undefined> {
  const title = decodeURIComponent(url.split("/wiki/")[1] ?? "");
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "pageimages",
    format: "json",
    origin: "*",
    piprop: "original",
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  if (res.status === 429) throw new Error("Rate limited (429)");
  const text = await res.text();
  let json: { query?: { pages?: Record<string, { original?: { source?: string } }> } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON (${res.status}): ${text.slice(0, 80)}`);
  }
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0] as { title?: string; original?: { source?: string } } | undefined;
  let originalUrl = page?.original?.source;
  if (!originalUrl && page?.title) {
    await sleep(REQUEST_DELAY_MS);
    const restRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
      { headers: { Accept: "application/json" } }
    );
    if (restRes.ok) {
      const rest = (await restRes.json()) as { originalimage?: { source?: string } };
      originalUrl = rest.originalimage?.source;
    }
  }
  return originalUrl;
}

function eventKey(date: string, url: string): string {
  return `${date}|${normalizeUrl(url)}`;
}

function isHttpUrl(s: string): boolean {
  const t = s.trim();
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
  const res = await fetch(`${WIKI_API}?${params}`);
  const json = (await res.json()) as { query?: { pages?: Record<string, { imageinfo?: { url?: string }[] }> } };
  const pages = json?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadAndSave(imageUrl: string, destPath: string): Promise<void> {
  if (fs.existsSync(destPath)) throw new Error(`File exists: ${destPath}`);
  const res = await fetch(imageUrl, { mode: "cors" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${imageUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());
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
      const msg = lastErr.message;
      if (attempt < RETRY_ATTEMPTS) {
        const is429 = msg.includes("429");
        const waitMs = is429 ? RATE_LIMIT_WAIT_MS : RETRY_DELAY_MS;
        if (is429) console.log(`[svg] Download 429, waiting ${waitMs / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr ?? new Error("Download failed");
}

async function main(): Promise<void> {
  console.log("[svg] Fetching ONLY SVG files. Other formats are not touched.");
  if (!fs.existsSync(PICS_DIR)) {
    fs.mkdirSync(PICS_DIR, { recursive: true });
  }

  let manifest: Manifest = {};
  let manifestChanged = false;
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  }

  const usedDates = new Set<string>();
  for (const fn of Object.values(manifest)) {
    const m = fn?.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) usedDates.add(m[1]);
  }
  for (const f of fs.readdirSync(PICS_DIR)) {
    if (f === "_manifest.json") continue;
    const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) usedDates.add(m[1]);
  }

  function findTsvFiles(dir: string, base = ""): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(...findTsvFiles(path.join(dir, e.name), rel));
      } else if (e.name.endsWith(".tsv") && e.name !== "Main.tsv") {
        out.push(rel);
      }
    }
    return out;
  }

  const tsvFiles = findTsvFiles(SOURCES_DIR);
  const allRows: { date: string; url: string; image: string }[] = [];

  for (const file of tsvFiles) {
    const raw = fs.readFileSync(path.join(SOURCES_DIR, file), "utf-8");
    const rows = parseTsv(raw, file);
    allRows.push(...rows);
  }

  const seen = new Map<string, { date: string; url: string; image: string }>();
  for (const row of allRows) {
    const key = eventKey(row.date, row.url);
    const prev = seen.get(key);
    if (!prev || (row.image.trim() && !prev.image.trim())) {
      seen.set(key, row);
    }
  }
  const uniqueRows = Array.from(seen.values());

  const stats = { downloaded: 0, skippedNotSvg: 0, skippedDateUsed: 0, skippedHasSvg: 0, failed: 0 };

  for (const row of uniqueRows) {
    const key = eventKey(row.date, row.url);

    if (usedDates.has(row.date)) {
      stats.skippedDateUsed++;
      continue;
    }

    const existingSvg = path.join(PICS_DIR, `${row.date}.svg`);
    if (fs.existsSync(existingSvg)) {
      manifest[key] = `${row.date}.svg`;
      usedDates.add(row.date);
      manifestChanged = true;
      stats.skippedHasSvg++;
      continue;
    }

    let imageUrl: string | undefined;

    const manualImage = row.image.trim();
    if (manualImage) {
      if (isHttpUrl(manualImage)) {
        imageUrl = manualImage;
      } else {
        if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
        imageUrl = await resolveImageUrl(manualImage);
      }
    } else if (row.url.includes("wikipedia.org")) {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
          imageUrl = await fetchWikiOriginalImage(row.url);
          break;
        } catch (e) {
          if (String(e).includes("429") && attempt < RETRY_ATTEMPTS) {
            await sleep(RATE_LIMIT_WAIT_MS);
          } else {
            stats.failed++;
            break;
          }
        }
      }
    }

    if (!imageUrl) {
      stats.skippedNotSvg++;
      continue;
    }

    if (!isSvgUrl(imageUrl)) {
      stats.skippedNotSvg++;
      continue;
    }

    const filename = `${row.date}.svg`;
    const destPath = path.join(PICS_DIR, filename);

    try {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      await downloadWithRetry(imageUrl, destPath);
      manifest[key] = filename;
      usedDates.add(row.date);
      manifestChanged = true;
      stats.downloaded++;
      console.log(`[svg] saved ${filename}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[svg] FAIL ${key}: ${errMsg}`);
      stats.failed++;
    }
  }

  if (manifestChanged) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  console.log("\n--- Summary ---");
  console.log(`downloaded SVG: ${stats.downloaded}`);
  console.log(`skipped (not SVG): ${stats.skippedNotSvg}`);
  console.log(`skipped (date already has file): ${stats.skippedDateUsed}`);
  console.log(`skipped (already has SVG): ${stats.skippedHasSvg}`);
  console.log(`failed: ${stats.failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
