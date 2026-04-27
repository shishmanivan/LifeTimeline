export type ProfileAvailability = "public" | "disabled";

export type ProfileDatasetBinding = {
  /**
   * Prepared personal dataset binding used by backend reads/writes.
   * Keep this explicit so future profiles can diverge from the profile id if needed.
   */
  profileId: string;
  /**
   * Optional per-user dataset folder name under the server data root.
   * Missing means legacy shared storage, used by the existing seeded profiles.
   */
  dirName?: string;
};

export type ProfileModel = {
  /** Stable profile identity used in routing / owner mapping. */
  id: string;
  /**
   * Registered user id that owns this profile. May be `""` for legacy seeded
   * profiles until linked or inferred during identity store normalization.
   */
  ownerUserId: string;
  slug: string;
  displayName: string;
  availability: ProfileAvailability;
  personalDataset: ProfileDatasetBinding;
};

export function isProfileAvailable(
  profile: Pick<ProfileModel, "availability">
): boolean {
  return profile.availability === "public";
}

export function getProfileDatasetProfileId(
  profile: Pick<ProfileModel, "personalDataset">
): string {
  return profile.personalDataset.profileId;
}

export function getProfileDatasetDirName(
  profile: Pick<ProfileModel, "personalDataset">
): string | undefined {
  const dirName = profile.personalDataset.dirName?.trim();
  return dirName || undefined;
}
