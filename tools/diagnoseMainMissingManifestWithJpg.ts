#!/usr/bin/env node
/**
 * Read-only diagnosis for main-layer gaps:
 * TSV row present, expected {date}.jpg exists, but normalized manifest key missing.
 *
 * Usage: npx tsx tools/diagnoseMainMissingManifestWithJpg.ts
 * Does not modify any data files.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(PROJECT_ROOT, "src", "history");
const MAIN_SOURCES = path.join(HISTORY_DIR, "sources");
const MAIN_PICS = path.join(HISTORY_DIR, "HistoryPics");
const MAIN_MANIFEST = path.join(MAIN_PICS, "_manifest.json");
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(_\d+)?$/;
const LIMIT = 20;

type ParsedRow = {
  date: string;
  url: string;
  urlRaw: string;
  image: string;
  title: string;
};
type Manifest = Record<string, string>;

const OTHER_LAYERS = [
  { label: "culture", sourcesDir: path.join(HISTORY_DIR, "sources", "Culture"), picsDir: path.join(HISTORY_DIR, "HistoryPics", "Culture") },
  { label: "autos", sourcesDir: path.join(HISTORY_DIR, "sources", "Autos"), picsDir: path.join(HISTORY_DIR, "HistoryPics", "Autos") },
  { label: "tech", sourcesDir: path.join(HISTORY_DIR, "sources", "Tech"), picsDir: path.join(HISTORY_DIR, "HistoryPics", "Tech") },
] as const;

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* keep */
    }
    pathname = pathname.replace(/\/+$/, "");
    return `${u.origin}${pathname}`;
  } catch {
    return url.trim();
  }
}

function eventKey(date: string, url: string): string {
  return `${date}|${normalizeUrl(url)}`;
}

function baseDate(d: string): string {
  return d.replace(/_\d+$/, "");
}

function titleIdx(headers: string[]): number {
  for (const name of ["title", "en_title", "ru_title"]) {
    const i = headers.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

function parseTsv(raw: string): ParsedRow[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const dateIdx = idx("date");
  const urlIdx = idx("url");
  const enUrlIdx = idx("en_url");
  const imageIdx = idx("image");
  const tIdx = titleIdx(headers);
  const hasUrl = urlIdx >= 0 || enUrlIdx >= 0;
  if (dateIdx < 0 || !hasUrl) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cells = line.split("\t");
    const get = (col: number) => (col >= 0 && col < cells.length ? cells[col].trim() : "");
    const date = get(dateIdx);
    const urlRaw = enUrlIdx >= 0 ? get(enUrlIdx) : get(urlIdx);
    const image = imageIdx >= 0 ? get(imageIdx) : "";
    const title = tIdx >= 0 ? get(tIdx) : "";

    if (!DATE_REGEX.test(date) || !urlRaw.startsWith("http")) continue;
    rows.push({
      date,
      url: normalizeUrl(urlRaw),
      urlRaw,
      image,
      title,
    });
  }
  return rows;
}

function collectTsvFiles(dir: string, includeFile: (name: string) => boolean, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...collectTsvFiles(path.join(dir, e.name), includeFile, rel));
    else if (includeFile(e.name)) out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function dedupeRows(allRows: ParsedRow[]): Map<string, ParsedRow> {
  const deduped = new Map<string, ParsedRow>();
  for (const row of allRows) {
    const key = eventKey(row.date, row.url);
    const prev = deduped.get(key);
    if (!prev || (row.image.trim() && !prev.image.trim())) deduped.set(key, row);
  }
  return deduped;
}

function loadNormalizedManifest(manifestPath: string): Map<string, string> {
  if (!fs.existsSync(manifestPath)) return new Map();
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
  const map = new Map<string, string>();
  for (const [key, filename] of Object.entries(raw)) {
    const pipe = key.indexOf("|");
    if (pipe < 0) continue;
    const date = key.slice(0, pipe);
    const urlPart = key.slice(pipe + 1);
    map.set(eventKey(date, urlPart), filename);
  }
  return map;
}

/** Raw manifest rows for tracing url part before normalization */
type RawManifestRow = { rawKey: string; normKey: string; filename: string; urlPartRaw: string };

function loadRawManifestRows(manifestPath: string): RawManifestRow[] {
  if (!fs.existsSync(manifestPath)) return [];
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
  const out: RawManifestRow[] = [];
  for (const [rawKey, filename] of Object.entries(raw)) {
    const pipe = rawKey.indexOf("|");
    if (pipe < 0) continue;
    const date = rawKey.slice(0, pipe);
    const urlPartRaw = rawKey.slice(pipe + 1);
    out.push({
      rawKey,
      normKey: eventKey(date, urlPartRaw),
      filename,
      urlPartRaw,
    });
  }
  return out;
}

function mainInclude(name: string): boolean {
  return name.endsWith(".tsv") && name !== "Main.tsv";
}

function rowsFromDir(sourcesDir: string, includeFile: (name: string) => boolean): ParsedRow[] {
  const files = collectTsvFiles(sourcesDir, includeFile);
  const rows: ParsedRow[] = [];
  for (const rel of files) {
    rows.push(...parseTsv(fs.readFileSync(path.join(sourcesDir, rel), "utf-8")));
  }
  return rows;
}

function inMainTsv(date: string, normUrl: string): boolean {
  const mainPath = path.join(MAIN_SOURCES, "Main.tsv");
  if (!fs.existsSync(mainPath)) return false;
  const rows = parseTsv(fs.readFileSync(mainPath, "utf-8"));
  return rows.some((r) => r.date === date && r.url === normUrl);
}

/** Heuristic: same wiki title slug, different encodings / dashes */
function wikiSlug(url: string): string {
  try {
    const m = url.match(/\/wiki\/(.+)$/);
    if (!m) return url;
    return decodeURIComponent(m[1].toLowerCase());
  } catch {
    return url;
  }
}

type Cause =
  | "jpg_claimed_by_other_norm_key"
  | "same_date_keys_but_no_file_claim"
  | "no_keys_for_this_date_prefix"
  | "tsv_duplicate_exact_date_multiply_urls"
  | "same_base_date_multiple_suffixes_in_tsv"
  | "wiki_slug_matches_other_manifest_key"
  | "other";

function classify(params: {
  keysForJpg: RawManifestRow[];
  keysSameDatePrefix: RawManifestRow[];
  tsvDistinctUrlsSameDate: number;
  tsvDistinctSuffixesSameBase: number;
  wikiSlugCollision: RawManifestRow | undefined;
}): Cause {
  if (params.tsvDistinctUrlsSameDate >= 2) return "tsv_duplicate_exact_date_multiply_urls";
  if (params.keysForJpg.length > 0) return "jpg_claimed_by_other_norm_key";
  if (params.wikiSlugCollision) return "wiki_slug_matches_other_manifest_key";
  if (params.tsvDistinctSuffixesSameBase > 1) return "same_base_date_multiple_suffixes_in_tsv";
  if (params.keysSameDatePrefix.length > 0) return "same_date_keys_but_no_file_claim";
  return "no_keys_for_this_date_prefix";
}

function nearestMatches(normUrl: string, rows: RawManifestRow[], maxN: number): RawManifestRow[] {
  const slug = wikiSlug(normUrl);
  const scored = rows
    .map((r) => {
      const s2 = wikiSlug(r.urlPartRaw);
      let score = 0;
      if (s2 === slug) score = 10000;
      else if (s2.includes(slug) || slug.includes(s2)) score = 5000 + Math.min(s2.length, slug.length);
      else {
        let common = 0;
        for (let i = 0; i < Math.min(s2.length, slug.length); i++) {
          if (s2[i] === slug[i]) common++;
          else break;
        }
        score = common;
      }
      return { row: r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxN).map((x) => x.row);
}

function main(): void {
  console.log("[diagnose:main] missing_in_manifest + expected .jpg on disk (first 20)\n");

  const mainRows = rowsFromDir(MAIN_SOURCES, mainInclude);
  const mainUnique = dedupeRows(mainRows);
  const manifestNorm = loadNormalizedManifest(MAIN_MANIFEST);
  const manifestRawMain = loadRawManifestRows(MAIN_MANIFEST);

  const candidates: { key: string; row: ParsedRow }[] = [];
  for (const [key, row] of mainUnique) {
    if (manifestNorm.has(key)) continue;
    const jpg = `${row.date}.jpg`;
    if (!fs.existsSync(path.join(MAIN_PICS, jpg))) continue;
    candidates.push({ key, row });
  }

  const selected = candidates.slice(0, LIMIT);
  if (selected.length === 0) {
    console.log("No cases in first batch (pipeline may be clean).");
    process.exit(0);
  }

  const otherLayerMaps: { label: string; hasKey: (k: string) => boolean }[] = [];
  for (const L of OTHER_LAYERS) {
    const include =
      L.label === "autos"
        ? (n: string) => n.endsWith(".tsv") && !n.startsWith("_")
        : (n: string) => n.endsWith(".tsv");
    const rows = rowsFromDir(L.sourcesDir, include);
    const uniq = dedupeRows(rows);
    const keys = new Set(uniq.keys());
    const m = loadNormalizedManifest(path.join(L.picsDir, "_manifest.json"));
    otherLayerMaps.push({
      label: L.label,
      hasKey: (k: string) => keys.has(k) || m.has(k),
    });
  }

  const causeCounts: Record<Cause, number> = {
    jpg_claimed_by_other_norm_key: 0,
    same_date_keys_but_no_file_claim: 0,
    no_keys_for_this_date_prefix: 0,
    tsv_duplicate_exact_date_multiply_urls: 0,
    same_base_date_multiple_suffixes_in_tsv: 0,
    wiki_slug_matches_other_manifest_key: 0,
    other: 0,
  };

  let i = 0;
  for (const { key: expectedKey, row } of selected) {
    i++;
    const date = row.date;
    const normUrl = row.url;
    const jpgName = `${date}.jpg`;
    const datePrefix = `${date}|`;

    const keysForJpg = manifestRawMain.filter((r) => r.filename === jpgName);
    const keysSameDatePrefix = manifestRawMain.filter((r) => r.rawKey.startsWith(datePrefix));

    const sameDateRows = mainRows.filter((r) => r.date === date);
    const tsvDistinctUrls = new Set(sameDateRows.map((r) => r.url)).size;

    const b = baseDate(date);
    const sameBaseRows = mainRows.filter((r) => baseDate(r.date) === b);
    const tsvDistinctSuffixesSameBase = new Set(sameBaseRows.map((r) => r.date)).size;

    const wikiSlugNorm = wikiSlug(normUrl);
    const wikiSlugCollision = manifestRawMain.find(
      (r) => r.normKey !== expectedKey && wikiSlug(r.urlPartRaw) === wikiSlugNorm
    );

    const normOnlyIssue = row.urlRaw.trim() !== normUrl && normalizeUrl(row.urlRaw) === normUrl;

    let otherLayer: string | undefined;
    for (const L of otherLayerMaps) {
      if (L.hasKey(expectedKey)) {
        otherLayer = L.label;
        break;
      }
    }

    const cause = classify({
      keysForJpg,
      keysSameDatePrefix,
      tsvDistinctUrlsSameDate: tsvDistinctUrls,
      tsvDistinctSuffixesSameBase,
      wikiSlugCollision,
    });

    causeCounts[cause]++;

    const otherKeysForSameJpg = keysForJpg.filter((r) => r.normKey !== expectedKey);

    const nearest = nearestMatches(normUrl, manifestRawMain, 3);

    console.log(`--- #${i} ---`);
    console.log(`  date (TSV):              ${date}`);
    console.log(`  en_url raw (cell):       ${row.urlRaw}`);
    console.log(`  normalized url:          ${normUrl}`);
    console.log(`  expected norm key:       ${expectedKey}`);
    console.log(`  expected jpg:            ${jpgName} (on disk)`);
    console.log(`  in Main.tsv (same key):  ${inMainTsv(date, normUrl)}`);
    console.log(`  TSV rows exact date:     ${sameDateRows.length} (distinct norm urls: ${tsvDistinctUrls})`);
    console.log(`  date base:               ${b}${date !== b ? ` (suffix variant)` : ""}`);

    console.log(`  manifest keys same date prefix (raw count): ${keysSameDatePrefix.length}`);
    if (keysSameDatePrefix.length > 0) {
      for (const r of keysSameDatePrefix.slice(0, 5)) {
        console.log(`    · normKey=${r.normKey} → ${r.filename}`);
      }
      if (keysSameDatePrefix.length > 5) console.log(`    … +${keysSameDatePrefix.length - 5} more`);
    }

    console.log(`  wiki_slug collision (diff normKey): ${wikiSlugCollision ? wikiSlugCollision.normKey : "none"}`);
    console.log(`  urlRaw trim equals norm string: ${row.urlRaw.trim() === normUrl} (unicode/path norm applied: ${normOnlyIssue})`);

    console.log(`  manifest entries pointing to ${jpgName}: ${keysForJpg.length}`);
    for (const r of otherKeysForSameJpg.slice(0, 3)) {
      console.log(`    · OTHER normKey=${r.normKey}`);
      console.log(`      rawKey=${r.rawKey}`);
    }

    console.log(
      `  TSV distinct full dates same base ${b}: ${tsvDistinctSuffixesSameBase} (rows: ${sameBaseRows.length})`
    );

    console.log(`  other layer has row/manifest: ${otherLayer ?? "no"}`);

    const hasSlugSibling = wikiSlugCollision !== undefined;
    if (cause === "no_keys_for_this_date_prefix" && !hasSlugSibling) {
      console.log(
        `  nearest manifest: (skipped — no keys with this date prefix; random slug matches are misleading)`
      );
    } else if (nearest.length > 0) {
      console.log(`  nearest manifest rows (wiki slug heuristic, weak):`);
      for (const r of nearest) {
        console.log(`    · ${r.normKey} → ${r.filename}`);
      }
    } else {
      console.log(`  nearest manifest rows: none`);
    }

    if (cause === "no_keys_for_this_date_prefix") {
      console.log(
        `  conclusion: manifest has ZERO entries for date=${date}; no row references ${jpgName}. Not a same-day URL collision in manifest — the key is simply absent (subset/stale manifest vs disk, or JPG landed after last manifest write).`
      );
    }

    console.log(`  → cause (heuristic): ${cause}`);
    console.log("");
  }

  console.log("── Summary (first 20 cases) ──");
  for (const [c, n] of Object.entries(causeCounts).sort((a, b) => b[1] - a[1])) {
    if (n > 0) console.log(`  ${n} × ${c}`);
  }

  const dominant = Object.entries(causeCounts).sort((a, b) => b[1] - a[1])[0];
  console.log(`\nDominant: ${dominant[0]} (${dominant[1]}/20)`);
  if (dominant[0] === "no_keys_for_this_date_prefix" && dominant[1] === LIMIT) {
    console.log(
      `\nOne-line root cause: _manifest.json has no keys for these calendar dates at all (no date|… rows), though the expected {date}.jpg files exist and TSV URLs normalize as expected. Timeline gaps here are from an under-filled manifest vs disk+TSV, not from another manifest row claiming the same JPG filename.`
    );
  }
}

main();
