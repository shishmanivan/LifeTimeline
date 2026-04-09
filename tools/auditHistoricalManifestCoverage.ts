#!/usr/bin/env node
/**
 * Read-only audit: TSV events vs HistoryPics manifests vs JPG files on disk.
 * Does not modify manifests or images.
 *
 * Usage: npm run history:audit
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(PROJECT_ROOT, "src", "history");
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(_\d+)?$/;

/** Cap lines per issue bucket per layer (full counts still in summary). */
const MAX_EXAMPLES = 20;

type ParsedRow = { date: string; url: string; image: string; title: string };
type Manifest = Record<string, string>;

type LayerTarget = {
  label: string;
  sourcesDir: string;
  picsDir: string;
  includeFile?: (fileName: string) => boolean;
  recurse?: boolean;
};

const LAYERS: LayerTarget[] = [
  {
    label: "main",
    sourcesDir: path.join(HISTORY_DIR, "sources"),
    picsDir: path.join(HISTORY_DIR, "HistoryPics"),
    includeFile: (fileName) => fileName.endsWith(".tsv") && fileName !== "Main.tsv",
    recurse: false,
  },
  {
    label: "culture",
    sourcesDir: path.join(HISTORY_DIR, "sources", "Culture"),
    picsDir: path.join(HISTORY_DIR, "HistoryPics", "Culture"),
    includeFile: (fileName) => fileName.endsWith(".tsv"),
    recurse: true,
  },
  {
    label: "autos",
    sourcesDir: path.join(HISTORY_DIR, "sources", "Autos"),
    picsDir: path.join(HISTORY_DIR, "HistoryPics", "Autos"),
    includeFile: (fileName) => fileName.endsWith(".tsv") && !fileName.startsWith("_"),
    recurse: true,
  },
  {
    label: "tech",
    sourcesDir: path.join(HISTORY_DIR, "sources", "Tech"),
    picsDir: path.join(HISTORY_DIR, "HistoryPics", "Tech"),
    includeFile: (fileName) => fileName.endsWith(".tsv"),
    recurse: true,
  },
];

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

function wikiTitleFromUrl(url: string): string {
  try {
    const m = url.match(/\/wiki\/(.+)$/);
    if (!m) return url;
    return decodeURIComponent(m[1].replace(/_/g, " "));
  } catch {
    return url;
  }
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

  const headers = lines[0].split("\t").map((header) => header.trim().toLowerCase());
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
    const url = enUrlIdx >= 0 ? get(enUrlIdx) : get(urlIdx);
    const image = imageIdx >= 0 ? get(imageIdx) : "";
    const title = tIdx >= 0 ? get(tIdx) : "";

    if (!DATE_REGEX.test(date) || !url.startsWith("http")) continue;
    rows.push({ date, url: normalizeUrl(url), image, title });
  }
  return rows;
}

function collectTsvFiles(
  dir: string,
  includeFile: (fileName: string) => boolean,
  recurse = true,
  base = ""
): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (recurse) {
        files.push(...collectTsvFiles(path.join(dir, entry.name), includeFile, recurse, rel));
      }
    } else if (includeFile(entry.name)) {
      files.push(rel);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function dedupeRows(allRows: ParsedRow[]): Map<string, ParsedRow> {
  const deduped = new Map<string, ParsedRow>();
  for (const row of allRows) {
    const key = eventKey(row.date, row.url);
    const prev = deduped.get(key);
    if (!prev || (row.image.trim() && !prev.image.trim())) {
      deduped.set(key, row);
    }
  }
  return deduped;
}

/** Normalize manifest keys to match TSV eventKey(); merge duplicate keys after norm. */
function loadNormalizedManifest(manifestPath: string): { map: Map<string, string>; rawCount: number; keyCollisions: number } {
  if (!fs.existsSync(manifestPath)) {
    return { map: new Map(), rawCount: 0, keyCollisions: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
  const map = new Map<string, string>();
  let keyCollisions = 0;
  for (const [key, filename] of Object.entries(raw)) {
    const pipe = key.indexOf("|");
    if (pipe < 0) continue;
    const date = key.slice(0, pipe);
    const urlPart = key.slice(pipe + 1);
    const normKey = eventKey(date, urlPart);
    if (map.has(normKey) && map.get(normKey) !== filename) {
      keyCollisions++;
    }
    map.set(normKey, filename);
  }
  return { map, rawCount: Object.keys(raw).length, keyCollisions };
}

function isJpgFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".jpg");
}

type Issue = {
  kind: string;
  date: string;
  label: string;
  key: string;
  filename?: string;
  /** For missing_in_manifest: whether ${date}.jpg exists in pics dir */
  expectedJpgOnDisk?: boolean;
};

function auditLayer(target: LayerTarget): { issues: Issue[]; summary: Record<string, number> } {
  const include = target.includeFile ?? ((f: string) => f.endsWith(".tsv"));
  const tsvPaths = collectTsvFiles(target.sourcesDir, include, target.recurse ?? true);
  const allRows: ParsedRow[] = [];
  for (const rel of tsvPaths) {
    const fullPath = path.join(target.sourcesDir, rel);
    allRows.push(...parseTsv(fs.readFileSync(fullPath, "utf-8")));
  }

  const unique = dedupeRows(allRows);
  const tsvKeys = new Set(unique.keys());
  const manifestPath = path.join(target.picsDir, "_manifest.json");
  const { map: manifestMap, rawCount, keyCollisions } = loadNormalizedManifest(manifestPath);

  const issues: Issue[] = [];

  for (const [key, row] of unique) {
    const filename = manifestMap.get(key);
    const shortLabel = row.title.trim() || wikiTitleFromUrl(row.url);

    if (filename === undefined) {
      const expectedFile = `${row.date}.jpg`;
      const expectedJpgOnDisk = fs.existsSync(path.join(target.picsDir, expectedFile));
      issues.push({
        kind: "missing_in_manifest",
        date: row.date,
        label: shortLabel,
        key,
        filename: expectedFile,
        expectedJpgOnDisk,
      });
      continue;
    }

    if (!isJpgFilename(filename)) {
      issues.push({
        kind: "manifest_not_jpg",
        date: row.date,
        label: shortLabel,
        key,
        filename,
      });
      continue;
    }

    const filePath = path.join(target.picsDir, filename);
    if (!fs.existsSync(filePath)) {
      issues.push({
        kind: "missing_jpg_file",
        date: row.date,
        label: shortLabel,
        key,
        filename,
      });
    }
  }

  for (const [key, filename] of manifestMap) {
    if (!tsvKeys.has(key)) {
      issues.push({
        kind: "extra_manifest_entry",
        date: key.slice(0, key.indexOf("|")),
        label: wikiTitleFromUrl(key.slice(key.indexOf("|") + 1)),
        key,
        filename,
      });
    }
  }

  const missingManifest = issues.filter((i) => i.kind === "missing_in_manifest");
  const summary = {
    tsv_raw_rows: allRows.length,
    tsv_unique_events: unique.size,
    manifest_raw_entries: rawCount,
    manifest_normalized_entries: manifestMap.size,
    missing_in_manifest: missingManifest.length,
    missing_in_manifest_but_jpg_on_disk: missingManifest.filter((i) => i.expectedJpgOnDisk).length,
    manifest_not_jpg: issues.filter((i) => i.kind === "manifest_not_jpg").length,
    missing_jpg_file: issues.filter((i) => i.kind === "missing_jpg_file").length,
    extra_manifest_entry: issues.filter((i) => i.kind === "extra_manifest_entry").length,
    manifest_key_collision: keyCollisions,
  };

  return { issues, summary };
}

function printExamples(label: string, kind: string, items: Issue[]): void {
  const filtered = items.filter((i) => i.kind === kind);
  if (filtered.length === 0) return;
  console.log(`  [${kind}] (${filtered.length})`);
  for (const it of filtered.slice(0, MAX_EXAMPLES)) {
    const fn = it.filename ? ` file=${it.filename}` : "";
    const disk =
      it.kind === "missing_in_manifest" && it.expectedJpgOnDisk !== undefined
        ? ` | expected_jpg_on_disk=${it.expectedJpgOnDisk}`
        : "";
    console.log(`    · ${it.date} | ${it.label.slice(0, 72)}${it.label.length > 72 ? "…" : ""}`);
    console.log(`      key=${it.key}${fn}${disk}`);
  }
  if (filtered.length > MAX_EXAMPLES) {
    console.log(`    … +${filtered.length - MAX_EXAMPLES} more`);
  }
}

function main(): void {
  console.log("[history:audit] Historical images coverage (TSV ↔ manifest ↔ .jpg on disk)\n");

  let totalProblems = 0;

  for (const layer of LAYERS) {
    const { issues, summary } = auditLayer(layer);
    const layerProblems =
      summary.missing_in_manifest +
      summary.manifest_not_jpg +
      summary.missing_jpg_file +
      summary.extra_manifest_entry +
      summary.manifest_key_collision;
    totalProblems += layerProblems;

    console.log(`── ${layer.label} ──`);
    console.log(
      `  TSV raw rows: ${summary.tsv_raw_rows} | unique events: ${summary.tsv_unique_events}`
    );
    console.log(
      `  Manifest raw entries: ${summary.manifest_raw_entries} | normalized keys: ${summary.manifest_normalized_entries}`
    );
    console.log(`  Missing in manifest: ${summary.missing_in_manifest}`);
    if (summary.missing_in_manifest_but_jpg_on_disk > 0) {
      console.log(
        `    (of those, ${summary.missing_in_manifest_but_jpg_on_disk} have expected .jpg on disk — likely key/sync issue)`
      );
    }
    console.log(`  Manifest not .jpg: ${summary.manifest_not_jpg}`);
    console.log(`  Manifest → missing .jpg on disk: ${summary.missing_jpg_file}`);
    console.log(`  Extra manifest (not in TSV): ${summary.extra_manifest_entry}`);
    if (summary.manifest_key_collision > 0) {
      console.log(`  Manifest key collisions after normalize: ${summary.manifest_key_collision}`);
    }

    if (layerProblems > 0) {
      printExamples(layer.label, "missing_in_manifest", issues);
      printExamples(layer.label, "manifest_not_jpg", issues);
      printExamples(layer.label, "missing_jpg_file", issues);
      printExamples(layer.label, "extra_manifest_entry", issues);
    }
    console.log("");
  }

  if (totalProblems === 0) {
    console.log("[history:audit] OK — no gaps detected.");
    process.exit(0);
  } else {
    console.log(`[history:audit] Done — ${totalProblems} issue(s) across layers (see above).`);
    process.exit(1);
  }
}

main();
