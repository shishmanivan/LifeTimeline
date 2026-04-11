import { getProfileDatasetProfileId, isProfileAvailable } from "../src/profileModel";
import type { PreparedPersonalDatasetScope } from "./personalDatasetResolver";
import { readIdentityStore } from "./identityStore";
import type { Profile } from "./profileRegistry";

export type { Profile };

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

export async function listProfilesForAdmin(): Promise<readonly Profile[]> {
  const store = await readIdentityStore();
  return store.profiles;
}
