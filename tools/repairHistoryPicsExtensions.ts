#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  detectFileExtension,
  normalizeImageExtension,
} from "./historyPicFileUtils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const TARGET_DIRS = [
  path.join(PROJECT_ROOT, "src", "history", "HistoryPics"),
  path.join(PROJECT_ROOT, "src", "history", "HistoryPics", "Culture"),
  path.join(PROJECT_ROOT, "src", "history", "HistoryPics", "Autos"),
  path.join(PROJECT_ROOT, "src", "history", "HistoryPics", "Tech"),
];

type Manifest = Record<string, string>;

function loadManifest(dirPath: string): Manifest {
  const manifestPath = path.join(dirPath, "_manifest.json");
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

function saveManifest(dirPath: string, manifest: Manifest): void {
  const manifestPath = path.join(dirPath, "_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function main(): void {
  let renamedCount = 0;
  let manifestUpdateCount = 0;

  for (const dirPath of TARGET_DIRS) {
    if (!fs.existsSync(dirPath)) continue;

    const manifest = loadManifest(dirPath);
    let manifestChanged = false;
    const renameMap = new Map<string, string>();

    for (const file of fs.readdirSync(dirPath)) {
      if (file === "_manifest.json") continue;

      const fullPath = path.join(dirPath, file);
      if (!fs.statSync(fullPath).isFile()) continue;

      const currentExt = normalizeImageExtension(path.extname(file));
      const actualExt = detectFileExtension(fullPath);
      if (!currentExt || !actualExt || currentExt === actualExt) continue;

      const base = file.slice(0, -path.extname(file).length);
      const targetFile = `${base}${actualExt}`;
      const targetPath = path.join(dirPath, targetFile);

      if (fs.existsSync(targetPath)) {
        renameMap.set(file, targetFile);
        continue;
      }

      fs.renameSync(fullPath, targetPath);
      renameMap.set(file, targetFile);
      renamedCount++;
      console.log(`[historypics:repair] Renamed ${path.relative(PROJECT_ROOT, fullPath)} -> ${targetFile}`);
    }

    if (renameMap.size === 0) continue;

    for (const [key, filename] of Object.entries(manifest)) {
      const renamed = renameMap.get(filename);
      if (!renamed) continue;
      manifest[key] = renamed;
      manifestChanged = true;
      manifestUpdateCount++;
    }

    if (manifestChanged) {
      saveManifest(dirPath, manifest);
    }
  }

  console.log(`[historypics:repair] Done. Renamed files: ${renamedCount}, manifest entries updated: ${manifestUpdateCount}`);
}

main();
