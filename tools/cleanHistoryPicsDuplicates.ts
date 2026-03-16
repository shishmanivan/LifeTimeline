#!/usr/bin/env node
/**
 * Remove duplicate HistoryPics files with suffixes _2, _3, _4, etc.
 * Keeps only the base file (e.g. 1905-09-05.webp) per date.
 *
 * Usage: npm run history:pics:clean
 *        or: npx tsx tools/cleanHistoryPicsDuplicates.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICS_DIR = path.resolve(__dirname, "..", "src", "history", "HistoryPics");
const MANIFEST_PATH = path.join(PICS_DIR, "_manifest.json");

const SUFFIX_REGEX = /^(\d{4}-\d{2}-\d{2})_(\d+)\.(webp|jpg|jpeg|png|avif|svg)$/i;

function main(): void {
  if (!fs.existsSync(PICS_DIR)) {
    console.log("[clean] HistoryPics folder not found");
    return;
  }

  const files = fs.readdirSync(PICS_DIR);
  const toDelete: string[] = [];

  for (const f of files) {
    if (f === "_manifest.json") continue;
    const m = f.match(SUFFIX_REGEX);
    if (m) {
      const num = parseInt(m[2], 10);
      if (num >= 2) {
        toDelete.push(f);
      }
    }
  }

  if (toDelete.length === 0) {
    console.log("[clean] No duplicate files found");
    return;
  }

  console.log(`[clean] Found ${toDelete.length} duplicate files to remove:`);
  for (const f of toDelete.sort()) {
    console.log(`  ${f}`);
  }

  const toDeleteSet = new Set(toDelete);
  for (const f of toDelete) {
    const p = path.join(PICS_DIR, f);
    fs.unlinkSync(p);
    console.log(`[clean] Deleted ${f}`);
  }

  if (fs.existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Record<string, string>;
    let changed = false;
    for (const [key, filename] of Object.entries(manifest)) {
      if (toDeleteSet.has(filename)) {
        delete manifest[key];
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
      console.log("[clean] Updated _manifest.json (removed references to deleted files)");
    }
  }

  console.log(`[clean] Done. Removed ${toDelete.length} files.`);
}

main();
