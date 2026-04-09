/**
 * MVP seeded owner — dev placeholder until real auth replaces it.
 * Not a login flow; single implicit owner tied to profile id "1".
 */
export type MvpCurrentUser = {
  id: string;
  profileId: string;
  /** URL path segment for this owner's default profile; align with backend profileRegistry. */
  profileSlug: string;
  displayName: string;
};

export const MVP_SEEDED_OWNER: MvpCurrentUser = {
  id: "owner-1",
  profileId: "1",
  profileSlug: "ivan",
  displayName: "Owner",
};

export function getMvpSeededCurrentUser(): MvpCurrentUser | null {
  return MVP_SEEDED_OWNER;
}

/** Canonical pathname (e.g. `/ivan`) for the MVP owner default profile when not on a slug route. */
export function getMvpOwnerCanonicalProfilePath(): string | null {
  const slug = MVP_SEEDED_OWNER.profileSlug.trim();
  return slug ? `/${slug}` : null;
}

export function computeIsOwnerViewingCurrentProfile(
  currentUserProfileId: string | null,
  isRootShortcut: boolean,
  activeProfile: { id: string } | null | undefined
): boolean {
  return (
    currentUserProfileId !== null &&
    (isRootShortcut || activeProfile?.id === currentUserProfileId)
  );
}
