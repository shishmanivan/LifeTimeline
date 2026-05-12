import path from "node:path";
import { access, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  ListServerPersonalPhotosResponse,
  ListServerSeriesResponse,
  ServerPersonalPhotoDto,
} from "../src/serverPersonalPhotoStorage";
import {
  normalizePhotoSocialSettings,
  type PhotoImportSourceMetadata,
  type PhotoSocialSettings,
} from "../src/photoSocial";

type PreparedSeriesRecord = {
  id: string;
  title: string;
  profileId: string;
};

type PreparedSeriesInput = Omit<PreparedSeriesRecord, "profileId"> & {
  profileId?: string;
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
  seriesIds?: string[];
  seriesReminder?: boolean;
  social?: PhotoSocialSettings;
  source?: PhotoImportSourceMetadata;
  imageFile: string;
  previewFile?: string;
};

export type PreparedPhotoSocialRecord = Pick<
  PreparedPhotoEntry,
  "id" | "profileId" | "social"
>;

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
  series: PreparedSeriesInput[];
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
  seriesReminder?: boolean;
  social?: PhotoSocialSettings;
};

export type PreparedSeriesPatch = {
  seriesId: string | null;
  seriesIds?: string[];
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

export type ImportPreparedPhotosInput = {
  sourceDataDir: string;
  sourcePhotoId: string;
  sourceProfileId: string;
  sourceProfileSlug: string;
  sourceAuthorName: string;
  targetProfileId: string;
  includeText: boolean;
  includeAllPhotosOfDay: boolean;
};

export type ImportPreparedPhotosResult = {
  createdPhotoIds: string[];
  skippedPhotoIds: string[];
};

export const DEFAULT_PERSONAL_DATA_DIR = path.resolve(
  process.cwd(),
  "FinalRez",
  "timeline-user-data"
);

const MANIFEST_FILENAME = "manifest.json";
const DEFAULT_PROFILE_ID = "";
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

function buildAssetUrl(
  assetBasePath: string,
  kind: PersonalAssetKind,
  fileName: string
): string {
  const normalizedBasePath =
    assetBasePath.replace(/\/+$/, "") || "/api/personal/assets";
  return `${normalizedBasePath}/${kind}/${encodeURIComponent(fileName)}`;
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
    seriesIds: photo.seriesIds,
    seriesReminder: photo.seriesReminder,
    social: normalizePhotoSocialSettings(photo.social),
    source: photo.source,
    imageUrl: buildAssetUrl(publicBaseUrl, "images", imageFileName),
    previewUrl: previewFileName
      ? buildAssetUrl(publicBaseUrl, "previews", previewFileName)
      : undefined,
  };
}

function normalizePreparedPhotoEntry(
  photo: PreparedPhotoEntry | (Omit<PreparedPhotoEntry, "profileId"> & { profileId?: string })
): PreparedPhotoEntry {
  const seriesIds = Array.from(
    new Set(
      [
        ...(Array.isArray(photo.seriesIds) ? photo.seriesIds : []),
        ...(photo.seriesId ? [photo.seriesId] : []),
      ].filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    )
  );

  return {
    ...photo,
    seriesId: seriesIds[0],
    seriesIds: seriesIds.length > 0 ? seriesIds : undefined,
    profileId: photo.profileId ?? DEFAULT_PROFILE_ID,
    social: normalizePhotoSocialSettings(photo.social),
  };
}

function assertPreparedAssetRelativePath(
  relativePath: string,
  expectedDir: PersonalAssetKind
): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!new RegExp(`^${expectedDir}/[^/]+$`).test(normalized)) {
    throw new Error(`Invalid ${expectedDir} asset path "${relativePath}".`);
  }
  return normalized;
}

function buildCopiedAssetFileName(photoId: string, sourceRelativePath: string): string {
  const ext = path.extname(sourceRelativePath).toLowerCase();
  return `${photoId}${ALLOWED_ASSET_EXTENSIONS.has(ext) ? ext : ".bin"}`;
}

async function copyPreparedAsset(
  sourceDataDir: string,
  targetDataDir: string,
  kind: PersonalAssetKind,
  sourceRelativePath: string,
  targetPhotoId: string
): Promise<string> {
  const normalizedSourcePath = assertPreparedAssetRelativePath(
    sourceRelativePath,
    kind
  );
  const targetFileName = buildCopiedAssetFileName(
    targetPhotoId,
    normalizedSourcePath
  );
  const targetRelativePath = `${kind}/${targetFileName}`;
  await mkdir(path.join(targetDataDir, kind), { recursive: true });
  await copyFile(
    path.join(sourceDataDir, normalizedSourcePath),
    path.join(targetDataDir, targetRelativePath)
  );
  return targetRelativePath;
}

function inferPreparedSeriesProfileId(
  seriesId: string,
  photos: readonly PreparedPhotoEntry[]
): string | null {
  const linkedProfileIds = photos
    .filter((photo) => (photo.seriesIds ?? (photo.seriesId ? [photo.seriesId] : [])).includes(seriesId))
    .map((photo) => photo.profileId ?? DEFAULT_PROFILE_ID);
  const uniqueProfileIds = [...new Set(linkedProfileIds)];
  return uniqueProfileIds.length === 1 ? uniqueProfileIds[0]! : null;
}

function normalizePreparedSeriesRecord(
  series: PreparedSeriesInput,
  photos: readonly PreparedPhotoEntry[]
): PreparedSeriesRecord {
  const normalizedProfileId =
    (typeof series.profileId === "string" && series.profileId.trim()) ||
    inferPreparedSeriesProfileId(series.id, photos) ||
    DEFAULT_PROFILE_ID;
  return {
    ...series,
    profileId: normalizedProfileId,
  };
}

function getManifestPath(dataDir: string): string {
  return path.join(dataDir, MANIFEST_FILENAME);
}

function buildEmptyPreparedManifest(): PreparedManifest {
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    series: [],
    photos: [],
  };
}

/** Base directory only; HTTP server should prefer `resolvePreparedPersonalDataDir` in `personalDatasetResolver`. */
export function resolvePersonalDataDir(dir = process.env.PERSONAL_PHOTO_DATA_DIR): string {
  return dir ? path.resolve(dir) : DEFAULT_PERSONAL_DATA_DIR;
}

export async function ensurePreparedPersonalDataset(
  dataDir: string
): Promise<void> {
  const manifestPath = getManifestPath(dataDir);
  try {
    await access(manifestPath);
  } catch {
    await mkdir(path.join(dataDir, "images"), { recursive: true });
    await mkdir(path.join(dataDir, "previews"), { recursive: true });
    await writePreparedManifest(dataDir, buildEmptyPreparedManifest());
  }
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

  const photos = manifest.photos.map((photo) => normalizePreparedPhotoEntry(photo));

  return {
    ...manifest,
    photos,
    series: manifest.series.map((series) =>
      normalizePreparedSeriesRecord(series, photos)
    ),
  };
}

export async function readPreparedPhotoProfileId(
  dataDir: string,
  photoId: string
): Promise<string | null> {
  const manifest = await readPreparedManifest(dataDir);
  const photo = manifest.photos.find((item) => item.id === photoId);
  return photo?.profileId ?? null;
}

export async function readPreparedPhotoSocialRecord(
  dataDir: string,
  photoId: string
): Promise<PreparedPhotoSocialRecord | null> {
  const manifest = await readPreparedManifest(dataDir);
  const photo = manifest.photos.find((item) => item.id === photoId);
  return photo
    ? {
        id: photo.id,
        profileId: photo.profileId,
        social: photo.social,
      }
    : null;
}

export async function readPreparedPhotoProfileIdsInDay(
  dataDir: string,
  date: string
): Promise<string[]> {
  const manifest = await readPreparedManifest(dataDir);
  return manifest.photos
    .filter((photo) => photo.date === date)
    .map((photo) => photo.profileId);
}

export async function readPreparedPhotoCountsByProfile(
  dataDir: string
): Promise<Map<string, number>> {
  const manifest = await readPreparedManifest(dataDir);
  const counts = new Map<string, number>();

  for (const photo of manifest.photos) {
    counts.set(photo.profileId, (counts.get(photo.profileId) ?? 0) + 1);
  }

  return counts;
}

export async function readPreparedSeries(
  dataDir: string,
  seriesId: string
): Promise<PreparedSeriesRecord | null> {
  const manifest = await readPreparedManifest(dataDir);
  const series = manifest.series.find((item) => item.id === seriesId);
  return series ? normalizePreparedSeriesRecord(series, manifest.photos) : null;
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
      series: manifest.series.map((series) =>
        normalizePreparedSeriesRecord(series, manifest.photos)
      ),
    },
  };
}

export async function importPreparedPhotos(
  targetDataDir: string,
  input: ImportPreparedPhotosInput
): Promise<ImportPreparedPhotosResult> {
  const [sourceManifest, targetManifest] = await Promise.all([
    readPreparedManifest(input.sourceDataDir),
    readPreparedManifest(targetDataDir),
  ]);
  const selectedSourcePhoto = sourceManifest.photos.find(
    (photo) =>
      photo.id === input.sourcePhotoId &&
      photo.profileId === input.sourceProfileId
  );
  if (!selectedSourcePhoto) {
    throw new Error("Source photo not found.");
  }

  const sourcePhotos = input.includeAllPhotosOfDay
    ? sourceManifest.photos.filter(
        (photo) =>
          photo.profileId === input.sourceProfileId &&
          photo.date === selectedSourcePhoto.date
      )
    : [selectedSourcePhoto];
  const copiedAt = new Date().toISOString();
  const createdPhotoIds: string[] = [];
  const skippedPhotoIds: string[] = [];

  for (const sourcePhoto of sourcePhotos) {
    const existing = targetManifest.photos.find(
      (photo) =>
        photo.profileId === input.targetProfileId &&
        photo.source?.kind === "imported-photo" &&
        photo.source.sourcePhotoId === sourcePhoto.id
    );
    if (existing) {
      skippedPhotoIds.push(existing.id);
      continue;
    }

    const id = randomUUID();
    const imageFile = await copyPreparedAsset(
      input.sourceDataDir,
      targetDataDir,
      "images",
      sourcePhoto.imageFile,
      id
    );
    const previewFile = sourcePhoto.previewFile
      ? await copyPreparedAsset(
          input.sourceDataDir,
          targetDataDir,
          "previews",
          sourcePhoto.previewFile,
          id
        )
      : undefined;

    targetManifest.photos.push({
      id,
      title: sourcePhoto.title,
      date: sourcePhoto.date,
      type: "personal",
      profileId: input.targetProfileId,
      note: input.includeText ? sourcePhoto.note : "",
      offsetY: sourcePhoto.offsetY,
      offsetXDays: sourcePhoto.offsetXDays,
      laneIndex: sourcePhoto.laneIndex,
      showOnTimeline: sourcePhoto.showOnTimeline,
      social: {
        reactionsEnabled: false,
        allowedReactions: [],
      },
      source: {
        kind: "imported-photo",
        sourcePhotoId: sourcePhoto.id,
        sourceProfileId: input.sourceProfileId,
        sourceProfileSlug: input.sourceProfileSlug,
        sourceAuthorName: input.sourceAuthorName,
        copiedAt,
        copiedText: input.includeText,
      },
      imageFile,
      ...(previewFile ? { previewFile } : {}),
    });
    createdPhotoIds.push(id);
  }

  if (createdPhotoIds.length > 0) {
    await writePreparedManifest(targetDataDir, targetManifest);
  }

  return {
    createdPhotoIds,
    skippedPhotoIds,
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
  series: PreparedSeriesInput
): Promise<void> {
  const manifest = await readPreparedManifest(dataDir);
  const index = manifest.series.findIndex((item) => item.id === series.id);
  const nextSeries = normalizePreparedSeriesRecord(
    index === -1 ? series : { ...manifest.series[index], ...series },
    manifest.photos
  );

  if (index === -1) {
    manifest.series.push(nextSeries);
  } else {
    manifest.series[index] = nextSeries;
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
    social: normalizePhotoSocialSettings(input.metadata.social),
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

  const nextSeriesIds = patch.seriesIds
    ? Array.from(
        new Set(patch.seriesIds.filter((value) => value.trim().length > 0))
      )
    : patch.seriesId
      ? [patch.seriesId]
      : [];

  if (nextSeriesIds.some((seriesId) => !manifest.series.some((series) => series.id === seriesId))) {
    return "series-not-found";
  }

  manifest.photos[photoIndex] = {
    ...manifest.photos[photoIndex],
    seriesId: nextSeriesIds[0],
    seriesIds: nextSeriesIds.length > 0 ? nextSeriesIds : undefined,
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
