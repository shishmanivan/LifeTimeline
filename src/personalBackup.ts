/**
 * Export / import personal photos, captions (title), notes, series, offsets.
 * Folder mode: writes `timeline-user-data/manifest.json` + `images/` + `previews/`.
 * Fallback: single JSON with base64 blobs (Safari / no directory picker).
 */

import {
  assignPersonalLaneIndex,
  getAllPhotos,
  getAllSeries,
  savePhoto,
  saveSeries,
  type PhotoRecord,
  type SeriesRecord,
} from "./db";

export const BACKUP_DIR_NAME = "timeline-user-data";
export const MANIFEST_FILE = "manifest.json";
export const FORMAT_VERSION = 1;

export type BackupPhotoEntry = {
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

export type BackupManifest = {
  formatVersion: number;
  exportedAt: string;
  series: SeriesRecord[];
  photos: BackupPhotoEntry[];
};

export type EmbeddedBackupFile = {
  formatVersion: number;
  exportedAt: string;
  embedded: true;
  series: SeriesRecord[];
  photos: Array<
    Omit<BackupPhotoEntry, "imageFile" | "previewFile"> & {
      imageMime: string;
      imageBase64: string;
      previewMime?: string;
      previewBase64?: string;
    }
  >;
};

export function supportsDirectoryBackup(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function" &&
    window.isSecureContext === true
  );
}

function safeFileSegment(id: string): string {
  return id.replace(/[/\\:*?"<>|]/g, "_");
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "bin";
}

async function writeUtf8Json(
  dir: FileSystemDirectoryHandle,
  name: string,
  obj: unknown
): Promise<void> {
  const text = JSON.stringify(obj, null, 2);
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(new Blob([text], { type: "application/json;charset=utf-8" }));
  await w.close();
}

async function writeBlobToDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob
): Promise<void> {
  const h = await dir.getFileHandle(filename, { create: true });
  const w = await h.createWritable();
  await w.write(blob);
  await w.close();
}

async function readTextFromRoot(root: FileSystemDirectoryHandle, name: string): Promise<string> {
  const h = await root.getFileHandle(name);
  const f = await h.getFile();
  return f.text();
}

/** Relative path like "images/foo.jpg" from backup root */
async function readBlobFromRoot(
  root: FileSystemDirectoryHandle,
  relPath: string
): Promise<Blob> {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid path: ${relPath}`);
  let dir: FileSystemDirectoryHandle = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  const h = await dir.getFileHandle(parts[parts.length - 1]!);
  const file = await h.getFile();
  return file;
}

async function resolveBackupRoot(
  picked: FileSystemDirectoryHandle
): Promise<FileSystemDirectoryHandle | null> {
  try {
    await picked.getFileHandle(MANIFEST_FILE);
    return picked;
  } catch {
    try {
      return await picked.getDirectoryHandle(BACKUP_DIR_NAME);
    } catch {
      return null;
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string;
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

async function applyImportedRecords(
  photos: PhotoRecord[],
  series: SeriesRecord[]
): Promise<void> {
  for (const s of series) {
    await saveSeries(s);
  }
  for (const p of photos) {
    await savePhoto(p);
  }
  const all = await getAllPhotos();
  const withLanes = assignPersonalLaneIndex(all);
  for (const r of withLanes) {
    await savePhoto(r);
  }
}

/**
 * User picks a parent folder; we create `timeline-user-data/` inside it.
 */
export async function exportBackupToPickedFolder(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const pickDir = window.showDirectoryPicker;
  if (typeof pickDir !== "function") {
    return { ok: false, error: "Ваш браузер не поддерживает запись в папку. Используйте «Скачать JSON»." };
  }
  try {
    const parent = await pickDir.call(window, { mode: "readwrite" });
    const root = await parent.getDirectoryHandle(BACKUP_DIR_NAME, { create: true });
    const imagesDir = await root.getDirectoryHandle("images", { create: true });
    const previewsDir = await root.getDirectoryHandle("previews", { create: true });

    const photos = await getAllPhotos();
    const series = await getAllSeries();
    const entries: BackupPhotoEntry[] = [];

    for (const p of photos) {
      const base = safeFileSegment(p.id);
      const imgExt = extForMime(p.imageBlob.type);
      const imageName = `${base}.${imgExt}`;
      await writeBlobToDir(imagesDir, imageName, p.imageBlob);

      let previewFile: string | undefined;
      if (p.previewBlob && p.previewBlob.size > 0) {
        const prevExt = extForMime(p.previewBlob.type);
        const prevName = `${base}.${prevExt}`;
        await writeBlobToDir(previewsDir, prevName, p.previewBlob);
        previewFile = `previews/${prevName}`;
      }

      entries.push({
        id: p.id,
        title: p.title,
        date: p.date,
        type: "personal",
        note: p.note,
        offsetY: p.offsetY,
        offsetXDays: p.offsetXDays,
        laneIndex: p.laneIndex,
        showOnTimeline: p.showOnTimeline,
        seriesId: p.seriesId,
        imageFile: `images/${imageName}`,
        previewFile,
      });
    }

    const manifest: BackupManifest = {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      series,
      photos: entries,
    };

    await writeUtf8Json(root, MANIFEST_FILE, manifest);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort")) return { ok: false, error: "Отменено." };
    return { ok: false, error: msg };
  }
}

/**
 * User picks folder that is either `timeline-user-data` or its parent.
 */
export async function importBackupFromPickedFolder(): Promise<
  { ok: true; importedPhotos: number; importedSeries: number } | { ok: false; error: string }
> {
  const pickDir = window.showDirectoryPicker;
  if (typeof pickDir !== "function") {
    return { ok: false, error: "Ваш браузер не поддерживает чтение из папки. Используйте «Загрузить JSON»." };
  }
  try {
    const picked = await pickDir.call(window, { mode: "read" });
    const root = await resolveBackupRoot(picked);
    if (!root) {
      return {
        ok: false,
        error: `Не найден ${MANIFEST_FILE}. Выберите папку «${BACKUP_DIR_NAME}» или каталог, где она лежит.`,
      };
    }

    const text = await readTextFromRoot(root, MANIFEST_FILE);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(text) as BackupManifest;
    } catch {
      return { ok: false, error: "Файл manifest.json повреждён или не JSON." };
    }

    if (manifest.formatVersion !== 1 || !Array.isArray(manifest.photos) || !Array.isArray(manifest.series)) {
      return { ok: false, error: "Неизвестный формат резервной копии." };
    }

    const records: PhotoRecord[] = [];
    for (const e of manifest.photos) {
      if (!e.id || typeof e.title !== "string" || typeof e.date !== "string" || !e.imageFile) {
        return { ok: false, error: `Некорректная запись фото: ${e.id ?? "?"}` };
      }
      const imageBlob = await readBlobFromRoot(root, e.imageFile);
      let previewBlob: Blob | undefined;
      if (e.previewFile) {
        try {
          previewBlob = await readBlobFromRoot(root, e.previewFile);
        } catch {
          previewBlob = undefined;
        }
      }
      records.push({
        id: e.id,
        title: e.title,
        date: e.date,
        type: "personal",
        imageBlob,
        previewBlob,
        offsetY: e.offsetY,
        offsetXDays: e.offsetXDays,
        laneIndex: e.laneIndex,
        showOnTimeline: e.showOnTimeline,
        seriesId: e.seriesId,
        note: e.note,
      });
    }

    await applyImportedRecords(records, manifest.series);
    return {
      ok: true,
      importedPhotos: records.length,
      importedSeries: manifest.series.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort")) return { ok: false, error: "Отменено." };
    return { ok: false, error: msg };
  }
}

export async function exportBackupAsJsonDownload(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const photos = await getAllPhotos();
    const series = await getAllSeries();
    const embedded: EmbeddedBackupFile = {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      embedded: true,
      series,
      photos: [],
    };

    for (const p of photos) {
      const imageBase64 = await blobToBase64(p.imageBlob);
      let previewBase64: string | undefined;
      let previewMime: string | undefined;
      if (p.previewBlob && p.previewBlob.size > 0) {
        previewBase64 = await blobToBase64(p.previewBlob);
        previewMime = p.previewBlob.type || "image/webp";
      }
      embedded.photos.push({
        id: p.id,
        title: p.title,
        date: p.date,
        type: "personal",
        note: p.note,
        offsetY: p.offsetY,
        offsetXDays: p.offsetXDays,
        laneIndex: p.laneIndex,
        showOnTimeline: p.showOnTimeline,
        seriesId: p.seriesId,
        imageMime: p.imageBlob.type || "image/jpeg",
        imageBase64,
        previewMime,
        previewBase64,
      });
    }

    const json = JSON.stringify(embedded);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timeline-personal-backup-${embedded.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function importBackupFromJsonFile(
  file: File
): Promise<
  { ok: true; importedPhotos: number; importedSeries: number } | { ok: false; error: string }
> {
  try {
    const text = await file.text();
    let data: EmbeddedBackupFile;
    try {
      data = JSON.parse(text) as EmbeddedBackupFile;
    } catch {
      return { ok: false, error: "Файл не является корректным JSON." };
    }

    if (data.formatVersion !== 1 || data.embedded !== true || !Array.isArray(data.photos)) {
      return { ok: false, error: "Неизвестный формат файла (нужен встроенный бэкап)." };
    }

    const series = Array.isArray(data.series) ? data.series : [];
    const records: PhotoRecord[] = [];

    for (const e of data.photos) {
      if (!e.id || typeof e.title !== "string" || typeof e.date !== "string" || !e.imageBase64) {
        return { ok: false, error: `Некорректная запись фото: ${e.id ?? "?"}` };
      }
      const imageBlob = base64ToBlob(e.imageBase64, e.imageMime || "image/jpeg");
      let previewBlob: Blob | undefined;
      if (e.previewBase64) {
        previewBlob = base64ToBlob(e.previewBase64, e.previewMime || "image/webp");
      }
      records.push({
        id: e.id,
        title: e.title,
        date: e.date,
        type: "personal",
        imageBlob,
        previewBlob,
        offsetY: e.offsetY,
        offsetXDays: e.offsetXDays,
        laneIndex: e.laneIndex,
        showOnTimeline: e.showOnTimeline,
        seriesId: e.seriesId,
        note: e.note,
      });
    }

    await applyImportedRecords(records, series);
    return {
      ok: true,
      importedPhotos: records.length,
      importedSeries: series.length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
