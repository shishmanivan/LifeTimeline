import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type PhotoViewIdentity =
  | {
      type: "account";
      userId: string;
      viewerId?: string;
    }
  | {
      type: "anonymous";
      viewerId: string;
    };

export type PhotoViewStats = {
  uniqueAccountViews: number;
  uniqueGuestViews: number;
  uniqueViews: number;
  rawOpens: number;
};

type StoredPhotoViewer = {
  firstViewedAt: string;
  lastViewedAt: string;
  openCount: number;
};

type StoredPhotoViewRecord = {
  accountViewers: Record<string, StoredPhotoViewer>;
  anonymousViewers: Record<string, StoredPhotoViewer>;
};

type PhotoViewStoreData = {
  formatVersion: 1;
  photos: Record<string, StoredPhotoViewRecord>;
};

export type RecordPhotoViewResult = PhotoViewStats & {
  countedUnique: boolean;
};

const DEFAULT_PHOTO_VIEW_STORE_PATH = path.resolve(
  process.cwd(),
  ".runtime-data",
  "photo-view-store.json"
);

let updateQueue: Promise<unknown> = Promise.resolve();

function getPhotoViewStorePath(
  envStorePath = process.env.PHOTO_VIEW_STORE_PATH
): string {
  const trimmedPath = envStorePath?.trim();
  return trimmedPath ? path.resolve(trimmedPath) : DEFAULT_PHOTO_VIEW_STORE_PATH;
}

function buildEmptyStore(): PhotoViewStoreData {
  return {
    formatVersion: 1,
    photos: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeViewerRecord(value: unknown): StoredPhotoViewer | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.firstViewedAt !== "string" ||
    typeof value.lastViewedAt !== "string"
  ) {
    return null;
  }
  const openCount =
    typeof value.openCount === "number" && Number.isFinite(value.openCount)
      ? Math.max(1, Math.floor(value.openCount))
      : 1;
  return {
    firstViewedAt: value.firstViewedAt,
    lastViewedAt: value.lastViewedAt,
    openCount,
  };
}

function normalizeViewerMap(value: unknown): Record<string, StoredPhotoViewer> {
  if (!isRecord(value)) return {};
  const result: Record<string, StoredPhotoViewer> = {};
  for (const [viewerKey, rawViewer] of Object.entries(value)) {
    const normalized = normalizeViewerRecord(rawViewer);
    if (normalized) {
      result[viewerKey] = normalized;
    }
  }
  return result;
}

function normalizePhotoRecord(value: unknown): StoredPhotoViewRecord {
  if (!isRecord(value)) {
    return {
      accountViewers: {},
      anonymousViewers: {},
    };
  }

  return {
    accountViewers: normalizeViewerMap(value.accountViewers),
    anonymousViewers: normalizeViewerMap(value.anonymousViewers),
  };
}

function normalizeStore(raw: unknown): PhotoViewStoreData {
  if (
    !isRecord(raw) ||
    raw.formatVersion !== 1 ||
    !isRecord(raw.photos)
  ) {
    return buildEmptyStore();
  }

  const photos: Record<string, StoredPhotoViewRecord> = {};
  for (const [photoId, rawPhoto] of Object.entries(raw.photos)) {
    photos[photoId] = normalizePhotoRecord(rawPhoto);
  }

  return {
    formatVersion: 1,
    photos,
  };
}

async function readPhotoViewStore(
  storePath = getPhotoViewStorePath()
): Promise<PhotoViewStoreData> {
  try {
    const raw = await readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return buildEmptyStore();
    }
    throw error;
  }
}

async function writePhotoViewStore(
  store: PhotoViewStoreData,
  storePath = getPhotoViewStorePath()
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function getOrCreatePhotoRecord(
  store: PhotoViewStoreData,
  photoId: string
): StoredPhotoViewRecord {
  const existing = store.photos[photoId];
  if (existing) return existing;
  const created: StoredPhotoViewRecord = {
    accountViewers: {},
    anonymousViewers: {},
  };
  store.photos[photoId] = created;
  return created;
}

function upsertViewer(
  viewers: Record<string, StoredPhotoViewer>,
  viewerKey: string,
  viewedAt: string
): boolean {
  const existing = viewers[viewerKey];
  if (!existing) {
    viewers[viewerKey] = {
      firstViewedAt: viewedAt,
      lastViewedAt: viewedAt,
      openCount: 1,
    };
    return true;
  }

  existing.lastViewedAt = viewedAt;
  existing.openCount += 1;
  return false;
}

function getPhotoStats(photo: StoredPhotoViewRecord): PhotoViewStats {
  const accountViewers = Object.values(photo.accountViewers);
  const anonymousViewers = Object.values(photo.anonymousViewers);
  const uniqueAccountViews = accountViewers.length;
  const uniqueGuestViews = anonymousViewers.length;
  return {
    uniqueAccountViews,
    uniqueGuestViews,
    uniqueViews: uniqueAccountViews + uniqueGuestViews,
    rawOpens: [...accountViewers, ...anonymousViewers].reduce(
      (sum, viewer) => sum + viewer.openCount,
      0
    ),
  };
}

function enqueueStoreUpdate<T>(work: () => Promise<T>): Promise<T> {
  const next = updateQueue.then(work, work);
  updateQueue = next.catch(() => undefined);
  return next;
}

export async function recordPhotoView(
  photoId: string,
  identity: PhotoViewIdentity,
  viewedAt = new Date().toISOString()
): Promise<RecordPhotoViewResult> {
  return await enqueueStoreUpdate(async () => {
    const store = await readPhotoViewStore();
    const photo = getOrCreatePhotoRecord(store, photoId);

    let countedUnique = false;
    if (identity.type === "account") {
      if (identity.viewerId) {
        delete photo.anonymousViewers[identity.viewerId];
      }
      countedUnique = upsertViewer(photo.accountViewers, identity.userId, viewedAt);
    } else {
      countedUnique = upsertViewer(
        photo.anonymousViewers,
        identity.viewerId,
        viewedAt
      );
    }

    await writePhotoViewStore(store);
    return {
      countedUnique,
      ...getPhotoStats(photo),
    };
  });
}

export async function readPhotoViewStats(photoId: string): Promise<PhotoViewStats> {
  const store = await readPhotoViewStore();
  const photo = store.photos[photoId];
  if (!photo) {
    return {
      uniqueAccountViews: 0,
      uniqueGuestViews: 0,
      uniqueViews: 0,
      rawOpens: 0,
    };
  }
  return getPhotoStats(photo);
}
