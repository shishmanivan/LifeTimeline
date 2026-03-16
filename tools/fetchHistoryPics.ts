#!/usr/bin/env node
/**
 * Fetch historical event images from Wikipedia and save to HistoryPics.
 * One file per date: YYYY-MM-DD.ext only. Never creates _2, _3, _4.
 * Idempotent: re-run does not re-download.
 *
 * IMPORTANT: Pause OneDrive sync before running (OneDrive can create _2 copies on conflict).
 * Usage: npm run history:pics
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

/** Normalize URL for consistent manifest keys (avoids duplicates from %E2%80%93 vs –, trailing slash, etc.) */
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

function eventKey(date: string, url: string): string {
  return `${date}|${normalizeUrl(url)}`;
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".webp")) return ".webp";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return ".jpg";
    if (pathname.endsWith(".png")) return ".png";
    if (pathname.endsWith(".svg")) return ".svg";
  } catch {
    /* ignore */
  }
  return ".webp";
}

/** One file per date. Never creates _2, _3, _4. */
function filenameForDate(date: string, ext = ".webp"): string {
  const name = `${date}${ext}`;
  if (/_[234]\b/.test(name)) throw new Error(`BUG: filename must not contain _2/_3/_4: ${name}`);
  return name;
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
  const filename = path.basename(destPath);
  if (filename.includes("_2") || filename.includes("_3") || filename.includes("_4")) {
    throw new Error(`BUG: refusing to write filename with _2/_3/_4: ${filename}`);
  }
  if (fs.existsSync(destPath)) throw new Error(`File exists, refusing to overwrite: ${destPath}`);
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
        if (is429) console.log(`[historypics] Download 429, waiting ${waitMs / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr ?? new Error("Download failed");
}

async function main(): Promise<void> {
  console.log("[historypics] OneDrive: pause sync before running to avoid _2 conflict copies.");
  if (!fs.existsSync(PICS_DIR)) {
    fs.mkdirSync(PICS_DIR, { recursive: true });
  }

  let manifest: Manifest = {};
  let manifestChanged = false;
  if (fs.existsSync(MANIFEST_PATH)) {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
    const migrated: Manifest = {};
    for (const [key, filename] of Object.entries(raw)) {
      const pipe = key.indexOf("|");
      if (pipe < 0) continue;
      const date = key.slice(0, pipe);
      const url = key.slice(pipe + 1);
      const normKey = eventKey(date, url);
      const baseName = filename.replace(/_\d+(\.[^.]+)$/, "$1");
      if (!migrated[normKey]) migrated[normKey] = baseName;
    }
    const needsMigration =
      Object.keys(migrated).length !== Object.keys(raw).length ||
      Object.keys(migrated).some((k) => !(k in raw) || raw[k] !== migrated[k]);
    if (needsMigration) manifestChanged = true;
    manifest = migrated;
  }

  for (const [k, fn] of Object.entries(manifest)) {
    if (!fn || !fs.existsSync(path.join(PICS_DIR, fn))) {
      delete manifest[k];
      manifestChanged = true;
    }
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
  const duplicatesRemoved = allRows.length - uniqueRows.length;
  if (duplicatesRemoved > 0) {
    console.log(`[historypics] Deduplicated: ${allRows.length} rows -> ${uniqueRows.length} unique (${duplicatesRemoved} duplicates skipped)`);
  }

  const stats = {
    totalEvents: uniqueRows.length,
    downloaded: 0,
    downloadedManual: 0,
    hit: 0,
    skippedDateCollision: 0,
    skippedManual: 0,
    skippedNoWikiImage: 0,
    failed: 0,
  };
  const failedList: { key: string; url: string; error: string }[] = [];
  const skippedNoWikiList: { key: string; url: string }[] = [];

  for (const row of uniqueRows) {
    const key = eventKey(row.date, row.url);
    const existing = manifest[key];
    const filePath = existing ? path.join(PICS_DIR, existing) : null;
    const manualImage = row.image.trim();
    const manualIsSvg =
      manualImage.length > 0 &&
      (manualImage.toLowerCase().endsWith(".svg") || (manualImage.startsWith("http") && getExtensionFromUrl(manualImage) === ".svg"));
    const existingIsRaster = existing ? /\.(webp|jpg|jpeg|png)$/i.test(existing) : false;
    const skipExisting = existing && filePath && fs.existsSync(filePath) && !(manualIsSvg && existingIsRaster);
    if (skipExisting) {
      stats.hit++;
      continue;
    }

    const hasManualImage = manualImage.length > 0;
    const hasRasterOnDisk = fs.readdirSync(PICS_DIR).some((f) => f.startsWith(row.date) && f !== "_manifest.json" && /\.(webp|jpg|jpeg|png)$/i.test(f));
    const shouldUpgradeToSvg = manualIsSvg && (existingIsRaster || hasRasterOnDisk);

    if (usedDates.has(row.date) && !shouldUpgradeToSvg) {
      stats.skippedDateCollision++;
      continue;
    }

    if (hasManualImage) {
      let imageUrl: string | undefined;
      if (isHttpUrl(manualImage)) {
        imageUrl = manualImage;
      } else {
        if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
        imageUrl = await resolveImageUrl(manualImage);
      }
      if (imageUrl) {
        const ext = getExtensionFromUrl(imageUrl);
        const filename = filenameForDate(row.date, ext);
        const destPath = path.join(PICS_DIR, filename);
        if (fs.existsSync(destPath)) {
          manifest[key] = filename;
          usedDates.add(row.date);
          manifestChanged = true;
          stats.hit++;
          continue;
        }
        if (ext === ".svg" && usedDates.has(row.date)) {
          const rasterFiles = fs.readdirSync(PICS_DIR).filter((f) => f.startsWith(row.date) && /\.(webp|jpg|jpeg|png)$/i.test(f));
          for (const f of rasterFiles) {
            fs.unlinkSync(path.join(PICS_DIR, f));
            usedDates.delete(row.date);
          }
        }
        try {
          if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
          await downloadWithRetry(imageUrl, destPath);
          manifest[key] = filename;
          usedDates.add(row.date);
          manifestChanged = true;
          stats.downloadedManual++;
          console.log(`[historypics] DOWNLOADED_MANUAL ${key} -> ${filename} (path: ${destPath})`);
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

    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    let thumbnailUrl: string | undefined;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        thumbnailUrl = await fetchWikiThumbnail(row.url);
        break;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("429") && attempt < RETRY_ATTEMPTS) {
          console.log(`[historypics] RATE_LIMITED, waiting ${RATE_LIMIT_WAIT_MS / 1000}s before retry ${attempt}/${RETRY_ATTEMPTS}`);
          await sleep(RATE_LIMIT_WAIT_MS);
        } else {
          console.log(`[historypics] FAIL_FETCH ${key}: ${errMsg}`);
          stats.failed++;
          failedList.push({ key, url: row.url, error: errMsg });
          continue;
        }
      }
    }
    if (!thumbnailUrl) {
      console.log(`[historypics] SKIP_NO_WIKI_IMAGE ${key}`);
      stats.skippedNoWikiImage++;
      skippedNoWikiList.push({ key, url: row.url });
      continue;
    }

    const filename = filenameForDate(row.date);
    const destPath = path.join(PICS_DIR, filename);
    if (fs.existsSync(destPath)) {
      manifest[key] = filename;
      usedDates.add(row.date);
      manifestChanged = true;
      stats.hit++;
      continue;
    }
    try {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
      await downloadWithRetry(thumbnailUrl, destPath);
      manifest[key] = filename;
      usedDates.add(row.date);
      manifestChanged = true;
      stats.downloaded++;
      console.log(`[historypics] saved ${filename} (path: ${destPath})`);
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
  console.log(`skippedDateCollision: ${stats.skippedDateCollision}`);
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
