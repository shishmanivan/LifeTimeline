import type { HistoricalEvent } from "./history/types";

const DB_NAME = "LifeTimelineDB";
const DB_VERSION = 6;
const STORE_NAME = "photos";
const HISTORICAL_STORE = "historicalEvents";

export type PhotoRecord = {
  id: string;
  title: string;
  date: string;
  type: "personal";
  imageBlob: Blob;
  previewBlob?: Blob;
  offsetY?: number;
  offsetXDays?: number;
  /** Post/description text, editable in modal */
  note?: string;
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const ev = e as IDBVersionChangeEvent & { target: IDBOpenDBRequest };
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(HISTORICAL_STORE)) {
        const store = db.createObjectStore(HISTORICAL_STORE, { keyPath: "id" });
        store.createIndex("date", "date");
      }
      if ((ev.newVersion ?? db.version) === 6 && ev.target.transaction) {
        migrateHistoricalStripLegacyOffsets(ev.target.transaction);
      }
    };
  });
}

export async function savePhoto(photo: PhotoRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(photo);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}

export async function getAllPhotos(): Promise<PhotoRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
    tx.oncomplete = () => db.close();
  });
}

export async function getPhoto(id: string): Promise<PhotoRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ?? null);
    tx.oncomplete = () => db.close();
  });
}

export async function updatePhotoOffsets(
  id: string,
  offsetY: number,
  offsetXDays: number
): Promise<void> {
  const record = await getPhoto(id);
  if (!record) return;
  await savePhoto({ ...record, offsetY, offsetXDays });
}

export async function updatePhotoPreview(
  id: string,
  previewBlob: Blob
): Promise<void> {
  const record = await getPhoto(id);
  if (!record) return;
  await savePhoto({ ...record, previewBlob });
}

export async function updatePhotoNote(
  id: string,
  note: string
): Promise<void> {
  const record = await getPhoto(id);
  if (!record) return;
  await savePhoto({ ...record, note });
}

export async function deletePhoto(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}

export async function bulkUpsertHistoricalEvents(
  events: HistoricalEvent[]
): Promise<void> {
  const db = await openDB();
  const sanitized = events.map((e) =>
    sanitizeHistoricalEvent(e as unknown as Record<string, unknown>)
  );
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORICAL_STORE, "readwrite");
    const store = tx.objectStore(HISTORICAL_STORE);
    for (const event of sanitized) {
      store.put(event);
    }
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

const HISTORICAL_WHITELIST: (keyof HistoricalEvent)[] = [
  "id",
  "date",
  "url",
  "title",
  "lang",
  "thumbnailUrl",
  "previewBlob",
  "tags",
  "sourceFile",
  "sourceLine",
  "updatedAt",
  "enrichVersion",
  "summary",
  "importance",
  "ruUrl",
];

function sanitizeHistoricalEvent(raw: Record<string, unknown>): HistoricalEvent {
  if (import.meta.env.DEV) {
    const legacy: Record<string, unknown> = {};
    if ("offsetY" in raw && raw.offsetY !== undefined)
      legacy.recordOffsetY = raw.offsetY;
    if ("offsetXDays" in raw && raw.offsetXDays !== undefined)
      legacy.recordOffsetXDays = raw.offsetXDays;
    if ("lane" in raw && raw.lane !== undefined) legacy.lane = raw.lane;
    if ("manualPosition" in raw && raw.manualPosition !== undefined)
      legacy.manualPosition = raw.manualPosition;
    if (Object.keys(legacy).length > 0) {
      console.log("[history-debug] raw record had legacy layout fields", {
        id: raw.id,
        date: raw.date,
        ...legacy,
      });
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of HISTORICAL_WHITELIST) {
    if (k in raw && raw[k] !== undefined) out[k] = raw[k];
  }
  return out as HistoricalEvent;
}

function migrateHistoricalStripLegacyOffsets(tx: IDBTransaction): void {
  const store = tx.objectStore(HISTORICAL_STORE);
  const req = store.getAll();
  req.onsuccess = () => {
    const raw = (req.result || []) as Record<string, unknown>[];
    let cleaned = 0;
    for (const r of raw) {
      if (
        "offsetY" in r ||
        "offsetXDays" in r ||
        "lane" in r ||
        "manualPosition" in r
      ) {
        store.put(sanitizeHistoricalEvent(r));
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(
        `[history] cleaned ${cleaned} records with legacy offsets`
      );
    }
  };
}

export async function getHistoricalEventsInRange(
  start: string,
  end: string
): Promise<HistoricalEvent[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORICAL_STORE, "readonly");
    const store = tx.objectStore(HISTORICAL_STORE);
    const index = store.index("date");
    const range = IDBKeyRange.bound(start, end);
    const request = index.getAll(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const raw = request.result || [];
      resolve(raw.map((r) => sanitizeHistoricalEvent(r as Record<string, unknown>)));
    };
    tx.oncomplete = () => db.close();
  });
}

export async function countEventsForYear(year: number): Promise<number> {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const events = await getHistoricalEventsInRange(start, end);
  return events.length;
}

export async function getHistoricalEvent(
  id: string
): Promise<HistoricalEvent | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORICAL_STORE, "readonly");
    const store = tx.objectStore(HISTORICAL_STORE);
    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const raw = request.result;
      resolve(
        raw
          ? sanitizeHistoricalEvent(raw as Record<string, unknown>)
          : null
      );
    };
    tx.oncomplete = () => db.close();
  });
}

export async function getAllHistoricalEvents(): Promise<HistoricalEvent[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORICAL_STORE, "readonly");
    const store = tx.objectStore(HISTORICAL_STORE);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const raw = request.result || [];
      resolve(
        raw.map((r) => sanitizeHistoricalEvent(r as Record<string, unknown>))
      );
    };
    tx.oncomplete = () => db.close();
  });
}

export async function deleteHistoricalEventsByIds(
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORICAL_STORE, "readwrite");
    const store = tx.objectStore(HISTORICAL_STORE);
    for (const id of ids) {
      store.delete(id);
    }
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}
