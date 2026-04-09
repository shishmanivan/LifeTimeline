import path from "node:path";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { MVP_BACKEND_OWNER_DEFAULT_PROFILE_ID } from "./mvpOwnerContext";
import type {
  ListServerPersonalPhotosResponse,
  ListServerSeriesResponse,
  ServerPersonalPhotoDto,
} from "../src/serverPersonalPhotoStorage";

type PreparedSeriesRecord = {
  id: string;
  title: string;
};

type PreparedPhotoEntry = {
  id: string;
  title: string;
  date: string;
  type: "personal";
  profileId: string;
  note?: string;
  offsetY?: number;
  offsetXDays?: number;
  laneIndex?: number;
  showOnTimeline?: boolean;
  seriesId?: string;
  imageFile: string;
  previewFile?: string;
};

export type PreparedPhotoUpsertMetadata = Omit<
  PreparedPhotoEntry,
  "imageFile" | "previewFile" | "profileId"
> & {
  profileId?: string;
};

export type PreparedUploadedAsset = {
  bytes: Uint8Array;
  fileName?: string;
  contentType?: string;
};

type PreparedManifest = {
  formatVersion: number;
  exportedAt: string;
  series: PreparedSeriesRecord[];
  photos: PreparedPhotoEntry[];
};

export type PersonalAssetKind = "images" | "previews";

export type PreparedPersonalDataset = {
  photosResponse: ListServerPersonalPhotosResponse;
  seriesResponse: ListServerSeriesResponse;
};

export type PreparedPhotoMetadataPatch = {
  title?: string;
  date?: string;
  note?: string;
  offsetY?: number;
  offsetXDays?: number;
};

export type PreparedSeriesPatch = {
  seriesId: string | null;
};

export type SavePreparedPhotoInput = {
  metadata: PreparedPhotoUpsertMetadata;
  image: PreparedUploadedAsset;
  preview?: PreparedUploadedAsset;
};

export type ReplacePreparedPhotoImageInput = {
  image: PreparedUploadedAsset;
  preview?: PreparedUploadedAsset;
};

export const DEFAULT_PERSONAL_DATA_DIR = path.resolve(
  process.cwd(),
  "FinalRez",
  "timeline-user-data"
);

const MANIFEST_FILENAME = "manifest.json";
const DEFAULT_PROFILE_ID = MVP_BACKEND_OWNER_DEFAULT_PROFILE_ID;
const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".avif",
  ".jfif",
]);

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildAssetUrl(
  publicBaseUrl: string,
  kind: PersonalAssetKind,
  fileName: string
): string {
  return `${trimTrailingSlash(publicBaseUrl)}/api/personal/assets/${kind}/${encodeURIComponent(fileName)}`;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function extractAssetFileName(
  relativePath: string,
  expectedDir: PersonalAssetKind
): string {
  const normalized = normalizeRelativePath(relativePath);
  const prefix = `${expectedDir}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(
      `Expected ${expectedDir} asset path, received "${relativePath}"`
    );
  }

  const fileName = normalized.slice(prefix.length);
  if (!fileName || fileName.includes("/")) {
    throw new Error(`Invalid asset filename "${relativePath}"`);
  }

  return fileName;
}

function toPhotoDto(
  photo: PreparedPhotoEntry,
  publicBaseUrl: string
): ServerPersonalPhotoDto {
  const imageFileName = extractAssetFileName(photo.imageFile, "images");
  const previewFileName = photo.previewFile
    ? extractAssetFileName(photo.previewFile, "previews")
    : undefined;

  return {
    id: photo.id,
    title: photo.title,
    date: photo.date,
    type: "personal",
    profileId: photo.profileId,
    note: photo.note,
    offsetY: photo.offsetY,
    offsetXDays: photo.offsetXDays,
    laneIndex: photo.laneIndex,
    showOnTimeline: photo.showOnTimeline,
    seriesId: photo.seriesId,
    imageUrl: buildAssetUrl(publicBaseUrl, "images", imageFileName),
    previewUrl: previewFileName
      ? buildAssetUrl(publicBaseUrl, "previews", previewFileName)
      : undefined,
  };
}

function normalizePreparedPhotoEntry(
  photo: PreparedPhotoEntry | (Omit<PreparedPhotoEntry, "profileId"> & { profileId?: string })
): PreparedPhotoEntry {
  return {
    ...photo,
    profileId: photo.profileId ?? DEFAULT_PROFILE_ID,
  };
}

function getManifestPath(dataDir: string): string {
  return path.join(dataDir, MANIFEST_FILENAME);
}

/** Base directory only; HTTP server should prefer `resolvePreparedPersonalDataDir` in `personalDatasetResolver`. */
export function resolvePersonalDataDir(dir = process.env.PERSONAL_PHOTO_DATA_DIR): string {
  return dir ? path.resolve(dir) : DEFAULT_PERSONAL_DATA_DIR;
}

export async function ensurePreparedPersonalDataset(
  dataDir: string
): Promise<void> {
  await access(getManifestPath(dataDir));
}

async function readPreparedManifest(dataDir: string): Promise<PreparedManifest> {
  const manifestPath = getManifestPath(dataDir);
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as PreparedManifest;

  if (
    manifest.formatVersion !== 1 ||
    !Array.isArray(manifest.photos) ||
    !Array.isArray(manifest.series)
  ) {
    throw new Error(
      `Unsupported personal dataset format in ${manifestPath}`
    );
  }

  return {
    ...manifest,
    photos: manifest.photos.map((photo) => normalizePreparedPhotoEntry(photo)),
  };
}

async function writePreparedManifest(
  dataDir: string,
  manifest: PreparedManifest
): Promise<void> {
  const nextManifest: PreparedManifest = {
    ...manifest,
    exportedAt: new Date().toISOString(),
  };
  await writeFile(
    getManifestPath(dataDir),
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    "utf8"
  );
}

export async function readPreparedPersonalDataset(
  dataDir: string,
  publicBaseUrl: string
): Promise<PreparedPersonalDataset> {
  const manifest = await readPreparedManifest(dataDir);

  return {
    photosResponse: {
      photos: manifest.photos.map((photo) => toPhotoDto(photo, publicBaseUrl)),
    },
    seriesResponse: {
      series: manifest.series,
    },
  };
}

export async function updatePreparedPhotoMetadata(
  dataDir: string,
  photoId: string,
  patch: PreparedPhotoMetadataPatch
): Promise<boolean> {
  const manifest = await readPreparedManifest(dataDir);
  const photoIndex = manifest.photos.findIndex((photo) => photo.id === photoId);
  if (photoIndex === -1) {
    return false;
  }

  manifest.photos[photoIndex] = {
    ...manifest.photos[photoIndex],
    ...patch,
  };

  await writePreparedManifest(dataDir, manifest);
  return true;
}

export async function savePreparedSeries(
  dataDir: string,
  series: PreparedSeriesRecord
): Promise<void> {
  const manifest = await readPreparedManifest(dataDir);
  const index = manifest.series.findIndex((item) => item.id === series.id);

  if (index === -1) {
    manifest.series.push(series);
  } else {
    manifest.series[index] = series;
  }

  await writePreparedManifest(dataDir, manifest);
}

function pickAssetExtension(asset: PreparedUploadedAsset): string {
  const byMime = asset.contentType ? MIME_TYPE_EXTENSIONS[asset.contentType] : undefined;
  if (byMime) return byMime;

  const byFileName = asset.fileName
    ? path.extname(asset.fileName).toLowerCase()
    : "";
  if (ALLOWED_ASSET_EXTENSIONS.has(byFileName)) {
    return byFileName;
  }

  return ".bin";
}

async function writePreparedAsset(
  dataDir: string,
  kind: PersonalAssetKind,
  fileName: string,
  bytes: Uint8Array
): Promise<string> {
  const dirPath = path.join(dataDir, kind);
  await mkdir(dirPath, { recursive: true });
  await writeFile(path.join(dirPath, fileName), bytes);
  return `${kind}/${fileName}`;
}

async function deletePreparedAssetIfReplaced(
  dataDir: string,
  currentRelativePath: string | undefined,
  nextRelativePath: string | undefined
): Promise<void> {
  if (!currentRelativePath || currentRelativePath === nextRelativePath) {
    return;
  }

  const normalized = normalizeRelativePath(currentRelativePath);
  if (!/^(images|previews)\/[^/]+$/.test(normalized)) {
    return;
  }

  try {
    await unlink(path.join(dataDir, normalized));
  } catch {
    /* ignore missing or already removed files */
  }
}

async function deletePreparedAsset(
  dataDir: string,
  relativePath: string | undefined
): Promise<void> {
  await deletePreparedAssetIfReplaced(dataDir, relativePath, undefined);
}

export async function savePreparedPhoto(
  dataDir: string,
  input: SavePreparedPhotoInput
): Promise<void> {
  const manifest = await readPreparedManifest(dataDir);
  const previousEntry =
    manifest.photos.find((photo) => photo.id === input.metadata.id) ?? null;

  const imageFile = await writePreparedAsset(
    dataDir,
    "images",
    `${input.metadata.id}${pickAssetExtension(input.image)}`,
    input.image.bytes
  );
  const previewFile = input.preview
    ? await writePreparedAsset(
        dataDir,
        "previews",
        `${input.metadata.id}${pickAssetExtension(input.preview)}`,
        input.preview.bytes
      )
    : undefined;

  const nextEntry: PreparedPhotoEntry = {
    ...input.metadata,
    profileId: input.metadata.profileId ?? DEFAULT_PROFILE_ID,
    imageFile,
    ...(previewFile ? { previewFile } : {}),
  };

  const existingIndex = manifest.photos.findIndex(
    (photo) => photo.id === input.metadata.id
  );
  if (existingIndex === -1) {
    manifest.photos.push(nextEntry);
  } else {
    manifest.photos[existingIndex] = nextEntry;
  }

  await writePreparedManifest(dataDir, manifest);

  await deletePreparedAssetIfReplaced(
    dataDir,
    previousEntry?.imageFile,
    imageFile
  );
  await deletePreparedAssetIfReplaced(
    dataDir,
    previousEntry?.previewFile,
    previewFile
  );
}

export async function replacePreparedPhotoImage(
  dataDir: string,
  photoId: string,
  input: ReplacePreparedPhotoImageInput
): Promise<boolean> {
  const manifest = await readPreparedManifest(dataDir);
  const photoIndex = manifest.photos.findIndex((photo) => photo.id === photoId);
  if (photoIndex === -1) {
    return false;
  }

  const previousEntry = manifest.photos[photoIndex];
  const imageFile = await writePreparedAsset(
    dataDir,
    "images",
    `${photoId}${pickAssetExtension(input.image)}`,
    input.image.bytes
  );
  const previewFile = input.preview
    ? await writePreparedAsset(
        dataDir,
        "previews",
        `${photoId}${pickAssetExtension(input.preview)}`,
        input.preview.bytes
      )
    : undefined;

  manifest.photos[photoIndex] = {
    ...previousEntry,
    imageFile,
    ...(previewFile ? { previewFile } : {}),
  };
  if (!previewFile) {
    delete manifest.photos[photoIndex].previewFile;
  }

  await writePreparedManifest(dataDir, manifest);

  await deletePreparedAssetIfReplaced(
    dataDir,
    previousEntry.imageFile,
    imageFile
  );
  await deletePreparedAssetIfReplaced(
    dataDir,
    previousEntry.previewFile,
    previewFile
  );

  return true;
}

export async function deletePreparedPhoto(
  dataDir: string,
  photoId: string
): Promise<boolean> {
  const manifest = await readPreparedManifest(dataDir);
  const photoIndex = manifest.photos.findIndex((photo) => photo.id === photoId);
  if (photoIndex === -1) {
    return false;
  }

  const [deletedPhoto] = manifest.photos.splice(photoIndex, 1);
  await writePreparedManifest(dataDir, manifest);
  await deletePreparedAsset(dataDir, deletedPhoto.imageFile);
  await deletePreparedAsset(dataDir, deletedPhoto.previewFile);
  return true;
}

export async function deletePreparedPhotosInDay(
  dataDir: string,
  date: string
): Promise<string[]> {
  const manifest = await readPreparedManifest(dataDir);
  const toDelete = manifest.photos.filter((photo) => photo.date === date);
  if (toDelete.length === 0) {
    return [];
  }

  manifest.photos = manifest.photos.filter((photo) => photo.date !== date);
  await writePreparedManifest(dataDir, manifest);

  await Promise.all(
    toDelete.flatMap((photo) => [
      deletePreparedAsset(dataDir, photo.imageFile),
      deletePreparedAsset(dataDir, photo.previewFile),
    ])
  );

  return toDelete.map((photo) => photo.id);
}

export async function updatePreparedPhotoSeries(
  dataDir: string,
  photoId: string,
  patch: PreparedSeriesPatch
): Promise<"updated" | "photo-not-found" | "series-not-found"> {
  const manifest = await readPreparedManifest(dataDir);
  const photoIndex = manifest.photos.findIndex((photo) => photo.id === photoId);
  if (photoIndex === -1) {
    return "photo-not-found";
  }

  if (
    patch.seriesId !== null &&
    !manifest.series.some((series) => series.id === patch.seriesId)
  ) {
    return "series-not-found";
  }

  manifest.photos[photoIndex] = {
    ...manifest.photos[photoIndex],
    seriesId: patch.seriesId ?? undefined,
  };

  await writePreparedManifest(dataDir, manifest);
  return "updated";
}

export function resolveAssetFilePath(
  dataDir: string,
  kind: PersonalAssetKind,
  requestedFileName: string
): string | null {
  const decoded = decodeURIComponent(requestedFileName);
  const safeName = path.basename(decoded);
  if (!safeName || safeName !== decoded) return null;
  return path.join(dataDir, kind, safeName);
}
