import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type ProfileVisitStats = {
  lastVisitedAt: string | null;
  totalVisits: number;
};

type StoredProfileVisitRecord = {
  lastVisitedAt: string;
  totalVisits: number;
};

type ProfileVisitStoreData = {
  formatVersion: 1;
  profiles: Record<string, StoredProfileVisitRecord>;
};

const DEFAULT_PROFILE_VISIT_STORE_PATH = path.resolve(
  process.cwd(),
  ".runtime-data",
  "profile-visit-store.json"
);

let updateQueue: Promise<unknown> = Promise.resolve();

function getProfileVisitStorePath(
  envStorePath = process.env.PROFILE_VISIT_STORE_PATH
): string {
  const trimmedPath = envStorePath?.trim();
  return trimmedPath ? path.resolve(trimmedPath) : DEFAULT_PROFILE_VISIT_STORE_PATH;
}

function buildEmptyStore(): ProfileVisitStoreData {
  return {
    formatVersion: 1,
    profiles: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProfileVisitRecord(
  value: unknown
): StoredProfileVisitRecord | null {
  if (!isRecord(value) || typeof value.lastVisitedAt !== "string") {
    return null;
  }

  const totalVisits =
    typeof value.totalVisits === "number" && Number.isFinite(value.totalVisits)
      ? Math.max(0, Math.floor(value.totalVisits))
      : 0;

  return {
    lastVisitedAt: value.lastVisitedAt,
    totalVisits,
  };
}

function normalizeStore(raw: unknown): ProfileVisitStoreData {
  if (
    !isRecord(raw) ||
    raw.formatVersion !== 1 ||
    !isRecord(raw.profiles)
  ) {
    return buildEmptyStore();
  }

  const profiles: Record<string, StoredProfileVisitRecord> = {};
  for (const [profileId, rawProfile] of Object.entries(raw.profiles)) {
    const normalized = normalizeProfileVisitRecord(rawProfile);
    if (normalized) {
      profiles[profileId] = normalized;
    }
  }

  return {
    formatVersion: 1,
    profiles,
  };
}

async function readProfileVisitStore(
  storePath = getProfileVisitStorePath()
): Promise<ProfileVisitStoreData> {
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

async function writeProfileVisitStore(
  store: ProfileVisitStoreData,
  storePath = getProfileVisitStorePath()
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function enqueueStoreUpdate<T>(work: () => Promise<T>): Promise<T> {
  const next = updateQueue.then(work, work);
  updateQueue = next.catch(() => undefined);
  return next;
}

export async function recordProfileVisit(
  profileId: string,
  visitedAt = new Date().toISOString()
): Promise<ProfileVisitStats> {
  return await enqueueStoreUpdate(async () => {
    const store = await readProfileVisitStore();
    const existing = store.profiles[profileId];
    const next: StoredProfileVisitRecord = {
      lastVisitedAt: visitedAt,
      totalVisits: (existing?.totalVisits ?? 0) + 1,
    };
    store.profiles[profileId] = next;
    await writeProfileVisitStore(store);
    return next;
  });
}

export async function readProfileVisitStatsByProfileId(): Promise<
  Map<string, ProfileVisitStats>
> {
  const store = await readProfileVisitStore();
  return new Map(
    Object.entries(store.profiles).map(([profileId, record]) => [
      profileId,
      {
        lastVisitedAt: record.lastVisitedAt,
        totalVisits: record.totalVisits,
      },
    ])
  );
}
