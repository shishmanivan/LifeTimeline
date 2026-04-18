import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ProfileModel } from "../src/profileModel";
import { getProfileDatasetProfileId } from "../src/profileModel";
import { normalizeUserRole, type UserModel } from "../src/userModel";
import { PROFILE_REGISTRY } from "./profileRegistry";

export type StoredUserRecord = UserModel & {
  googleSubject?: string;
  /**
   * MVP-only per-user write token persisted server-side.
   * This is a transition bridge from owner token to user-owned editing.
   */
  mvpWriteAccessToken?: string;
  recoveryChallenge?: {
    code: string;
    expiresAt: string;
    requestedAt: string;
  };
};

export type IdentityStoreData = {
  formatVersion: 1;
  users: StoredUserRecord[];
  profiles: ProfileModel[];
};

const DEFAULT_IDENTITY_STORE_PATH = path.resolve(
  process.cwd(),
  "FinalRez",
  "identity-store.json"
);

type IdentityStorePathSource =
  | "IDENTITY_STORE_PATH"
  | "PERSONAL_IDENTITY_STORE_PATH"
  | "default";

export type IdentityStoreLocation = {
  storePath: string;
  legacyStorePath: string;
  source: IdentityStorePathSource;
  usesConfiguredPath: boolean;
};

export type EnsureIdentityStoreResult = IdentityStoreLocation & {
  initialization: "existing" | "migrated-from-legacy" | "created-empty";
};

function cloneProfile(profile: ProfileModel): ProfileModel {
  const ownerUserId =
    typeof profile.ownerUserId === "string" ? profile.ownerUserId : "";
  return {
    ...profile,
    ownerUserId,
    personalDataset: {
      ...profile.personalDataset,
    },
  };
}

/**
 * Legacy profiles may omit `ownerUserId` on disk; fill from `user.primaryProfileId`
 * when unambiguous. Prefer the explicit profile id match, but also accept the
 * prepared-dataset profile id for older records that stored that binding
 * instead. Skips profiles that already have a non-empty owner.
 */
function assignInferredProfileOwners(
  profiles: ProfileModel[],
  users: readonly StoredUserRecord[]
): ProfileModel[] {
  return profiles.map((profile) => {
    if (profile.ownerUserId.trim() !== "") {
      return profile;
    }
    const datasetProfileId = getProfileDatasetProfileId(profile);
    const ownerId = users.find(
      (u) =>
        u.primaryProfileId === profile.id ||
        u.primaryProfileId === datasetProfileId
    )?.id;
    if (ownerId) {
      return { ...profile, ownerUserId: ownerId };
    }
    return profile;
  });
}

function cloneUser(user: StoredUserRecord): StoredUserRecord {
  return {
    ...user,
    role: normalizeUserRole(user.role),
  };
}

function buildSeedIdentityStore(): IdentityStoreData {
  return {
    formatVersion: 1,
    users: [],
    profiles: PROFILE_REGISTRY.map((profile) => cloneProfile(profile)),
  };
}

export function getIdentityStorePath(
  envStorePath =
    process.env.IDENTITY_STORE_PATH || process.env.PERSONAL_IDENTITY_STORE_PATH
): string {
  const trimmedPath = envStorePath?.trim();
  return trimmedPath ? path.resolve(trimmedPath) : DEFAULT_IDENTITY_STORE_PATH;
}

export function getIdentityStoreLocation(): IdentityStoreLocation {
  const explicitPath = process.env.IDENTITY_STORE_PATH?.trim();
  if (explicitPath) {
    return {
      storePath: path.resolve(explicitPath),
      legacyStorePath: DEFAULT_IDENTITY_STORE_PATH,
      source: "IDENTITY_STORE_PATH",
      usesConfiguredPath: true,
    };
  }

  const legacyEnvPath = process.env.PERSONAL_IDENTITY_STORE_PATH?.trim();
  if (legacyEnvPath) {
    return {
      storePath: path.resolve(legacyEnvPath),
      legacyStorePath: DEFAULT_IDENTITY_STORE_PATH,
      source: "PERSONAL_IDENTITY_STORE_PATH",
      usesConfiguredPath: true,
    };
  }

  return {
    storePath: DEFAULT_IDENTITY_STORE_PATH,
    legacyStorePath: DEFAULT_IDENTITY_STORE_PATH,
    source: "default",
    usesConfiguredPath: false,
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeIdentityStoreFile(
  storePath: string,
  data: IdentityStoreData
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function mergeSeedProfiles(store: IdentityStoreData): IdentityStoreData {
  const users = store.users.map((user) => cloneUser(user));
  let profiles = store.profiles.map((profile) => cloneProfile(profile));
  profiles = assignInferredProfileOwners(profiles, users);

  const existingIds = new Set(profiles.map((profile) => profile.id));
  const existingSlugs = new Set(profiles.map((profile) => profile.slug));

  for (const seedProfile of PROFILE_REGISTRY) {
    if (
      existingIds.has(seedProfile.id) ||
      existingSlugs.has(seedProfile.slug)
    ) {
      continue;
    }
    profiles.push(cloneProfile(seedProfile));
  }

  profiles = assignInferredProfileOwners(profiles, users);

  return {
    formatVersion: 1,
    users,
    profiles,
  };
}

function normalizeIdentityStore(raw: unknown): IdentityStoreData {
  const seed = buildSeedIdentityStore();
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("formatVersion" in raw) ||
    (raw as { formatVersion?: unknown }).formatVersion !== 1 ||
    !("users" in raw) ||
    !Array.isArray((raw as { users?: unknown }).users) ||
    !("profiles" in raw) ||
    !Array.isArray((raw as { profiles?: unknown }).profiles)
  ) {
    return seed;
  }

  return mergeSeedProfiles({
    formatVersion: 1,
    users: (raw as IdentityStoreData).users.map((user) => cloneUser(user)),
    profiles: (raw as IdentityStoreData).profiles.map((profile) =>
      cloneProfile(profile)
    ),
  });
}

async function readNormalizedIdentityStoreFile(
  storePath: string
): Promise<{ raw: string; normalized: IdentityStoreData }> {
  const raw = await readFile(storePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Identity store at "${storePath}" contains invalid JSON.`,
      { cause: error }
    );
  }
  return {
    raw,
    normalized: normalizeIdentityStore(parsed),
  };
}

function getLocationForStorePath(storePath: string): IdentityStoreLocation {
  const defaultLocation = getIdentityStoreLocation();
  const resolvedStorePath = path.resolve(storePath);
  if (resolvedStorePath === defaultLocation.storePath) {
    return defaultLocation;
  }
  return {
    storePath: resolvedStorePath,
    legacyStorePath: DEFAULT_IDENTITY_STORE_PATH,
    source: "default",
    usesConfiguredPath: false,
  };
}

export async function ensureIdentityStore(
  storePath = getIdentityStorePath()
): Promise<EnsureIdentityStoreResult> {
  const location = getLocationForStorePath(storePath);
  if (await fileExists(location.storePath)) {
    const { raw, normalized } = await readNormalizedIdentityStoreFile(
      location.storePath
    );
    if (raw.trimEnd() !== JSON.stringify(normalized, null, 2)) {
      await writeIdentityStoreFile(location.storePath, normalized);
    }
    return {
      ...location,
      initialization: "existing",
    };
  }

  const shouldMigrateLegacy =
    location.usesConfiguredPath && location.storePath !== location.legacyStorePath;
  if (shouldMigrateLegacy && (await fileExists(location.legacyStorePath))) {
    const { normalized } = await readNormalizedIdentityStoreFile(
      location.legacyStorePath
    );
    await writeIdentityStoreFile(location.storePath, normalized);
    return {
      ...location,
      initialization: "migrated-from-legacy",
    };
  }

  await writeIdentityStoreFile(location.storePath, buildSeedIdentityStore());
  return {
    ...location,
    initialization: "created-empty",
  };
}

export async function readIdentityStore(
  storePath = getIdentityStorePath()
): Promise<IdentityStoreData> {
  await ensureIdentityStore(storePath);
  const raw = await readFile(storePath, "utf8");
  return normalizeIdentityStore(JSON.parse(raw));
}

export async function updateIdentityStore(
  mutate: (store: IdentityStoreData) => void | Promise<void>,
  storePath = getIdentityStorePath()
): Promise<IdentityStoreData> {
  const store = await readIdentityStore(storePath);
  await mutate(store);
  const normalized = normalizeIdentityStore(store);
  await writeIdentityStoreFile(storePath, normalized);
  return normalized;
}
