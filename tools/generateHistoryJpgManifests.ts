#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(PROJECT_ROOT, "src", "history");
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(_\d+)?$/;

type ParsedRow = { date: string; url: string; image: string };
type Manifest = Record<string, string>;

type ManifestTarget = {
  label: string;
  sourcesDir: string;
  picsDir: string;
  includeFile?: (fileName: string) => boolean;
  recurse?: boolean;
};

const TARGETS: ManifestTarget[] = [
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
      /* keep original pathname */
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

function parseTsv(raw: string): ParsedRow[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((header) => header.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const dateIdx = idx("date");
  const urlIdx = idx("url");
  const enUrlIdx = idx("en_url");
  const imageIdx = idx("image");
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

    if (!DATE_REGEX.test(date) || !url.startsWith("http")) continue;
    rows.push({ date, url: normalizeUrl(url), image });
  }
  return rows;
}

function collectFiles(
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
        files.push(...collectFiles(path.join(dir, entry.name), includeFile, recurse, rel));
      }
    } else if (includeFile(entry.name)) {
      files.push(rel);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function buildManifest(target: ManifestTarget): { manifest: Manifest; totalRows: number; mappedRows: number } {
  const tsvFiles = collectFiles(
    target.sourcesDir,
    target.includeFile ?? ((fileName) => fileName.endsWith(".tsv")),
    target.recurse ?? true
  );
  const allRows: ParsedRow[] = [];

  for (const file of tsvFiles) {
    const fullPath = path.join(target.sourcesDir, file);
    const raw = fs.readFileSync(fullPath, "utf-8");
    allRows.push(...parseTsv(raw));
  }

  const deduped = new Map<string, ParsedRow>();
  for (const row of allRows) {
    const key = eventKey(row.date, row.url);
    const prev = deduped.get(key);
    if (!prev || (row.image.trim() && !prev.image.trim())) {
      deduped.set(key, row);
    }
  }

  const manifest: Manifest = {};
  let mappedRows = 0;
  for (const row of deduped.values()) {
    const filename = `${row.date}.jpg`;
    const filePath = path.join(target.picsDir, filename);
    if (!fs.existsSync(filePath)) continue;
    manifest[eventKey(row.date, row.url)] = filename;
    mappedRows++;
  }

  return {
    manifest,
    totalRows: deduped.size,
    mappedRows,
  };
}

function main(): void {
  for (const target of TARGETS) {
    const manifestPath = path.join(target.picsDir, "_manifest.json");
    const { manifest, totalRows, mappedRows } = buildManifest(target);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    console.log(
      `[historypics:jpg-manifest] ${target.label}: wrote ${Object.keys(manifest).length} entries from ${mappedRows}/${totalRows} jpg-backed rows`
    );
  }
}

main();
