import { getProfileDatasetProfileId, isProfileAvailable } from "../src/profileModel";
import { readPreparedPhotoCountsByProfile } from "./personalDataset";
import type { PreparedPersonalDatasetScope } from "./personalDatasetResolver";
import { resolvePreparedPersonalDataDir } from "./personalDatasetResolver";
import { readIdentityStore } from "./identityStore";
import type { Profile } from "./profileRegistry";

export type { Profile };

export type AdminProfile = Profile & {
  accountCreatedAt: string | null;
  photoCount: number;
};

export async function getProfileBySlug(slug: string): Promise<Profile | undefined> {
  const store = await readIdentityStore();
  return store.profiles.find(
    (p) => p.slug === slug && isProfileAvailable(p)
  );
}

export async function getDefaultProfile(): Promise<Profile> {
  const store = await readIdentityStore();
  const profile = store.profiles.find((item) => isProfileAvailable(item));
  if (!profile) {
    throw new Error("No available profiles configured.");
  }
  return profile;
}

export function getProfileDatasetScope(
  profile: Pick<Profile, "personalDataset">
): PreparedPersonalDatasetScope {
  return {
    profileId: getProfileDatasetProfileId(profile),
  };
}

export async function listProfilesForAdmin(): Promise<readonly AdminProfile[]> {
  const store = await readIdentityStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const photoCounts = await readPreparedPhotoCountsByProfile(
    resolvePreparedPersonalDataDir(undefined)
  );

  return store.profiles.map((profile) => {
    const owner = usersById.get(profile.ownerUserId);
    const datasetProfileId = getProfileDatasetProfileId(profile);

    return {
      ...profile,
      accountCreatedAt: owner?.createdAt ?? null,
      photoCount: photoCounts.get(datasetProfileId) ?? 0,
    };
  });
}
