/**
 * MVP implicit “current user” on the server — not authentication.
 * Replace with real sessions / tokens when auth ships; keep profile fields aligned
 * with `profileRegistry` and the frontend `mvpOwnerAuth` model.
 */
export type MvpBackendOwnerUser = {
  id: string;
  profileId: string;
  profileSlug: string;
  displayName: string;
};

export const MVP_SEEDED_BACKEND_OWNER = {
  id: "owner-1",
  profileId: "1",
  profileSlug: "ivan",
  displayName: "Owner",
} as const satisfies MvpBackendOwnerUser;

/** Default `profileId` for prepared photos when none is stored (same as MVP owner’s profile). */
export const MVP_BACKEND_OWNER_DEFAULT_PROFILE_ID =
  MVP_SEEDED_BACKEND_OWNER.profileId;

export function getMvpSeededBackendCurrentUser(): MvpBackendOwnerUser {
  return MVP_SEEDED_BACKEND_OWNER;
}

export function getMvpBackendCurrentUserProfileId(): string {
  return MVP_SEEDED_BACKEND_OWNER.profileId;
}

export function isMvpBackendOwnerProfileId(profileId: string): boolean {
  return profileId === MVP_SEEDED_BACKEND_OWNER.profileId;
}

/** Hook for future write authorization: implicit actor vs target profile. */
export function mvpBackendOwnerMayAccessProfile(profileId: string): boolean {
  return isMvpBackendOwnerProfileId(profileId);
}
