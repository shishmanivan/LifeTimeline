import path from "node:path";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { savePreparedPhoto, savePreparedSeries, resolvePersonalDataDir } from "../backend/personalDataset";

const BACKUP_DIR_NAME = "timeline-user-data";
const MANIFEST_FILE = "manifest.json";
const FORMAT_VERSION = 1;

type BackupPhotoEntry = {
  id: string;
  title: string;
  date: string;
  type: "personal";
  note?: string;
  offsetY?: number;
  offsetXDays?: number;
  laneIndex?: number;
  showOnTimeline?: boolean;
  seriesId?: string;
  imageFile: string;
  previewFile?: string;
};

type BackupManifest = {
  formatVersion: number;
  exportedAt: string;
  series: Array<{ id: string; title: string; profileId?: string }>;
  photos: BackupPhotoEntry[];
};

type EmbeddedBackupFile = {
  formatVersion: number;
  exportedAt: string;
  embedded: true;
  series: Array<{ id: string; title: string; profileId?: string }>;
  photos: Array<
    Omit<BackupPhotoEntry, "imageFile" | "previewFile"> & {
      imageMime: string;
      imageBase64: string;
      previewMime?: string;
      previewBase64?: string;
    }
  >;
};

type ImportStats = {
  createdPhotos: number;
  updatedPhotos: number;
  createdSeries: number;
  updatedSeries: number;
};

function parseArgs(argv: string[]): { source: string; target: string } {
  let source: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      source = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--target") {
      target = argv[i + 1];
      i += 1;
      continue;
    }
  }

  if (!source) {
    throw new Error(
      "Missing required --source argument. Example: npm run personal:import -- --source \"C:\\path\\to\\timeline-user-data\""
    );
  }

  return {
    source: path.resolve(source),
    target: target ? path.resolve(target) : resolvePersonalDataDir(),
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureTargetDataset(targetDir: string): Promise<void> {
  await mkdir(path.join(targetDir, "images"), { recursive: true });
  await mkdir(path.join(targetDir, "previews"), { recursive: true });

  const manifestPath = path.join(targetDir, MANIFEST_FILE);
  if (await pathExists(manifestPath)) {
    return;
  }

  const emptyManifest: BackupManifest = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    series: [],
    photos: [],
  };
  await writeFile(manifestPath, `${JSON.stringify(emptyManifest, null, 2)}\n`, "utf8");
}

async function readManifestFromPath(manifestPath: string): Promise<BackupManifest> {
  const raw = stripBom(await readFile(manifestPath, "utf8"));
  const parsed = JSON.parse(raw) as BackupManifest;
  if (
    parsed.formatVersion !== FORMAT_VERSION ||
    !Array.isArray(parsed.photos) ||
    !Array.isArray(parsed.series)
  ) {
    throw new Error(`Unsupported backup manifest format in ${manifestPath}`);
  }
  return parsed;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function resolveFolderSource(sourcePath: string): Promise<{
  rootDir: string;
  manifest: BackupManifest;
}> {
  const directManifest = path.join(sourcePath, MANIFEST_FILE);
  if (await pathExists(directManifest)) {
    return {
      rootDir: sourcePath,
      manifest: await readManifestFromPath(directManifest),
    };
  }

  const nestedRoot = path.join(sourcePath, BACKUP_DIR_NAME);
  const nestedManifest = path.join(nestedRoot, MANIFEST_FILE);
  if (await pathExists(nestedManifest)) {
    return {
      rootDir: nestedRoot,
      manifest: await readManifestFromPath(nestedManifest),
    };
  }

  throw new Error(
    `Could not find ${MANIFEST_FILE}. Pass either the ${BACKUP_DIR_NAME} folder or its parent directory.`
  );
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  return Buffer.from(base64, "base64");
}

function normalizeImportPhotoType(value: unknown): "personal" {
  if (value !== "personal") {
    throw new Error('Only personal photo records are supported for import.');
  }
  return "personal";
}

async function readTargetIds(targetDir: string): Promise<{
  photoIds: Set<string>;
  seriesIds: Set<string>;
}> {
  const manifest = await readManifestFromPath(path.join(targetDir, MANIFEST_FILE));
  return {
    photoIds: new Set(manifest.photos.map((photo) => photo.id)),
    seriesIds: new Set(manifest.series.map((series) => series.id)),
  };
}

async function importFolderBackup(
  rootDir: string,
  manifest: BackupManifest,
  targetDir: string,
  stats: ImportStats
): Promise<void> {
  const existingIds = await readTargetIds(targetDir);

  for (const series of manifest.series) {
    if (existingIds.seriesIds.has(series.id)) {
      stats.updatedSeries += 1;
    } else {
      stats.createdSeries += 1;
      existingIds.seriesIds.add(series.id);
    }
    await savePreparedSeries(targetDir, series);
  }

  for (const photo of manifest.photos) {
    if (!photo.id || typeof photo.title !== "string" || typeof photo.date !== "string") {
      throw new Error(`Invalid photo entry in folder backup: ${photo.id ?? "unknown"}`);
    }

    const imagePath = path.join(rootDir, photo.imageFile);
    const previewPath = photo.previewFile
      ? path.join(rootDir, photo.previewFile)
      : undefined;
    const imageBytes = new Uint8Array(await readFile(imagePath));
    const previewBytes = previewPath && (await pathExists(previewPath))
      ? new Uint8Array(await readFile(previewPath))
      : undefined;

    if (existingIds.photoIds.has(photo.id)) {
      stats.updatedPhotos += 1;
    } else {
      stats.createdPhotos += 1;
      existingIds.photoIds.add(photo.id);
    }

    await savePreparedPhoto(targetDir, {
      metadata: {
        id: photo.id,
        title: photo.title,
        date: photo.date,
        type: normalizeImportPhotoType(photo.type),
        note: photo.note,
        offsetY: photo.offsetY,
        offsetXDays: photo.offsetXDays,
        laneIndex: photo.laneIndex,
        showOnTimeline: photo.showOnTimeline,
        seriesId: photo.seriesId,
      },
      image: {
        bytes: imageBytes,
        fileName: path.basename(photo.imageFile),
      },
      preview: previewBytes
        ? {
            bytes: previewBytes,
            fileName: path.basename(photo.previewFile!),
          }
        : undefined,
    });
  }
}

async function importEmbeddedJsonBackup(
  filePath: string,
  targetDir: string,
  stats: ImportStats
): Promise<void> {
  const raw = stripBom(await readFile(filePath, "utf8"));
  const parsed = JSON.parse(raw) as EmbeddedBackupFile;
  if (
    parsed.formatVersion !== FORMAT_VERSION ||
    parsed.embedded !== true ||
    !Array.isArray(parsed.photos) ||
    !Array.isArray(parsed.series)
  ) {
    throw new Error(`Unsupported embedded backup format in ${filePath}`);
  }

  const existingIds = await readTargetIds(targetDir);

  for (const series of parsed.series) {
    if (existingIds.seriesIds.has(series.id)) {
      stats.updatedSeries += 1;
    } else {
      stats.createdSeries += 1;
      existingIds.seriesIds.add(series.id);
    }
    await savePreparedSeries(targetDir, series);
  }

  for (const photo of parsed.photos) {
    if (
      !photo.id ||
      typeof photo.title !== "string" ||
      typeof photo.date !== "string" ||
      !photo.imageBase64
    ) {
      throw new Error(`Invalid embedded photo entry: ${photo.id ?? "unknown"}`);
    }

    if (existingIds.photoIds.has(photo.id)) {
      stats.updatedPhotos += 1;
    } else {
      stats.createdPhotos += 1;
      existingIds.photoIds.add(photo.id);
    }

    await savePreparedPhoto(targetDir, {
      metadata: {
        id: photo.id,
        title: photo.title,
        date: photo.date,
        type: normalizeImportPhotoType(photo.type),
        note: photo.note,
        offsetY: photo.offsetY,
        offsetXDays: photo.offsetXDays,
        laneIndex: photo.laneIndex,
        showOnTimeline: photo.showOnTimeline,
        seriesId: photo.seriesId,
      },
      image: {
        bytes: decodeBase64ToBytes(photo.imageBase64),
        fileName: `${photo.id}.bin`,
        contentType: photo.imageMime,
      },
      preview: photo.previewBase64
        ? {
            bytes: decodeBase64ToBytes(photo.previewBase64),
            fileName: `${photo.id}-preview.bin`,
            contentType: photo.previewMime,
          }
        : undefined,
    });
  }
}

async function importSource(sourcePath: string, targetDir: string): Promise<ImportStats> {
  await ensureTargetDataset(targetDir);

  const stats: ImportStats = {
    createdPhotos: 0,
    updatedPhotos: 0,
    createdSeries: 0,
    updatedSeries: 0,
  };

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory()) {
    const folderSource = await resolveFolderSource(sourcePath);
    await importFolderBackup(folderSource.rootDir, folderSource.manifest, targetDir, stats);
    return stats;
  }

  if (sourceStat.isFile()) {
    if (path.basename(sourcePath).toLowerCase() === MANIFEST_FILE) {
      const manifest = await readManifestFromPath(sourcePath);
      await importFolderBackup(path.dirname(sourcePath), manifest, targetDir, stats);
      return stats;
    }

    await importEmbeddedJsonBackup(sourcePath, targetDir, stats);
    return stats;
  }

  throw new Error(`Unsupported source path: ${sourcePath}`);
}

async function main(): Promise<void> {
  const { source, target } = parseArgs(process.argv.slice(2));
  console.log(`[personal-import] source: ${source}`);
  console.log(`[personal-import] target: ${target}`);
  const stats = await importSource(source, target);
  console.log(
    `[personal-import] series: created=${stats.createdSeries}, updated=${stats.updatedSeries}`
  );
  console.log(
    `[personal-import] photos: created=${stats.createdPhotos}, updated=${stats.updatedPhotos}`
  );
}

main().catch((error) => {
  console.error(
    `[personal-import] failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
