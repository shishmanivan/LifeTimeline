import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ProfileModel } from "../src/profileModel";
import { normalizeUserRole, type UserModel } from "../src/userModel";
import { PROFILE_REGISTRY } from "./profileRegistry";

export type StoredUserRecord = UserModel & {
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
 * when unambiguous. Skips profiles that already have a non-empty owner.
 */
function assignInferredProfileOwners(
  profiles: ProfileModel[],
  users: readonly StoredUserRecord[]
): ProfileModel[] {
  return profiles.map((profile) => {
    if (profile.ownerUserId.trim() !== "") {
      return profile;
    }
    const ownerId = users.find((u) => u.primaryProfileId === profile.id)?.id;
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
  envStorePath = process.env.PERSONAL_IDENTITY_STORE_PATH
): string {
  return envStorePath
    ? path.resolve(envStorePath)
    : DEFAULT_IDENTITY_STORE_PATH;
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

export async function ensureIdentityStore(
  storePath = getIdentityStorePath()
): Promise<void> {
  try {
    const raw = await readFile(storePath, "utf8");
    const normalized = normalizeIdentityStore(JSON.parse(raw));
    if (raw.trimEnd() !== JSON.stringify(normalized, null, 2)) {
      await writeIdentityStoreFile(storePath, normalized);
    }
  } catch {
    await writeIdentityStoreFile(storePath, buildSeedIdentityStore());
  }
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
