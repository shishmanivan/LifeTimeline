export type ProfileAvailability = "public" | "disabled";

export type ProfileDatasetBinding = {
  /**
   * Prepared personal dataset binding used by backend reads/writes.
   * Keep this explicit so future profiles can diverge from the profile id if needed.
   */
  profileId: string;
};

export type ProfileModel = {
  /** Stable profile identity used in routing / owner mapping. */
  id: string;
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
