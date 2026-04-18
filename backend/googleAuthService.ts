import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { getProfileDatasetProfileId, type ProfileModel } from "../src/profileModel";
import {
  normalizeUserRole,
  type GoogleAuthInput,
  type RegisterUserResult,
  type UserModel,
} from "../src/userModel";
import { updateIdentityStore, type StoredUserRecord } from "./identityStore";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() || "";

let googleClient: OAuth2Client | null = null;

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid-input"
      | "invalid-token"
      | "email-missing"
      | "email-not-verified"
      | "profile-missing"
      | "conflict"
      | "server-misconfigured",
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "GoogleAuthError";
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function slugify(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "profile";
}

function makeUniqueSlug(baseSlug: string, takenSlugs: Set<string>): string {
  if (!takenSlugs.has(baseSlug)) {
    return baseSlug;
  }

  let suffix = 2;
  while (takenSlugs.has(`${baseSlug}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseSlug}-${suffix}`;
}

function deriveDisplayName(email: string, candidateName: string | undefined): string {
  const name = candidateName?.trim();
  if (name) return name;
  return normalizeEmail(email).split("@")[0] ?? "Profile";
}

function createRegisteredProfile(
  profileId: string,
  displayName: string,
  slug: string,
  ownerUserId: string
): ProfileModel {
  return {
    id: profileId,
    ownerUserId,
    slug,
    displayName,
    availability: "public",
    personalDataset: {
      profileId,
    },
  };
}

function createRegisteredUser(
  userId: string,
  email: string,
  primaryProfileId: string,
  googleSubject: string
): StoredUserRecord {
  return {
    id: userId,
    email,
    status: "active",
    createdAt: new Date().toISOString(),
    role: "user",
    primaryProfileId,
    googleSubject,
  };
}

function toPublicUser(user: StoredUserRecord): UserModel {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    createdAt: user.createdAt,
    role: normalizeUserRole(user.role),
    primaryProfileId: user.primaryProfileId,
  };
}

function getGoogleClient(): OAuth2Client {
  if (!GOOGLE_CLIENT_ID) {
    throw new GoogleAuthError(
      "Google auth is not configured on the server. Set GOOGLE_CLIENT_ID.",
      "server-misconfigured"
    );
  }
  if (!googleClient) {
    googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  }
  return googleClient;
}

function getProfileForUser(
  profiles: readonly ProfileModel[],
  primaryProfileId: string | null
): ProfileModel | null {
  if (!primaryProfileId) {
    return null;
  }
  return (
    profiles.find(
      (profile) =>
        profile.id === primaryProfileId ||
        getProfileDatasetProfileId(profile) === primaryProfileId
    ) ?? null
  );
}

async function verifyGoogleCredential(input: GoogleAuthInput): Promise<{
  googleSubject: string;
  email: string;
  displayName?: string;
}> {
  const credential = input.credential.trim();
  if (!credential) {
    throw new GoogleAuthError("A Google credential is required.", "invalid-input");
  }

  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (cause) {
    throw new GoogleAuthError("The Google credential is invalid.", "invalid-token", {
      cause,
    });
  }

  if (!payload) {
    throw new GoogleAuthError(
      "The Google credential payload is missing.",
      "invalid-token"
    );
  }

  const googleSubject = payload.sub?.trim();
  if (!googleSubject) {
    throw new GoogleAuthError(
      "The Google credential is missing a subject.",
      "invalid-token"
    );
  }

  const email = payload.email ? normalizeEmail(payload.email) : "";
  if (!email) {
    throw new GoogleAuthError(
      "The Google account did not provide an email address.",
      "email-missing"
    );
  }

  if (payload.email_verified !== true) {
    throw new GoogleAuthError(
      "The Google account email must be verified.",
      "email-not-verified"
    );
  }

  return {
    googleSubject,
    email,
    displayName: typeof payload.name === "string" ? payload.name : undefined,
  };
}

export async function authenticateWithGoogle(
  input: GoogleAuthInput
): Promise<RegisterUserResult> {
  const verified = await verifyGoogleCredential(input);
  let result: RegisterUserResult | null = null;

  await updateIdentityStore((store) => {
    const userByGoogleSubject = store.users.find(
      (user) => user.googleSubject === verified.googleSubject
    );
    const userByEmail = store.users.find(
      (user) => normalizeEmail(user.email) === verified.email
    );

    let resolvedUser: StoredUserRecord;
    let resolvedProfile: ProfileModel | null = null;

    if (userByGoogleSubject) {
      resolvedUser = userByGoogleSubject;
      resolvedProfile = getProfileForUser(store.profiles, resolvedUser.primaryProfileId);
    } else if (userByEmail) {
      if (
        userByEmail.googleSubject &&
        userByEmail.googleSubject !== verified.googleSubject
      ) {
        throw new GoogleAuthError(
          "This email is already linked to another Google account.",
          "conflict"
        );
      }

      userByEmail.googleSubject = verified.googleSubject;
      resolvedUser = userByEmail;
      resolvedProfile = getProfileForUser(store.profiles, resolvedUser.primaryProfileId);
    } else {
      const displayName = deriveDisplayName(verified.email, verified.displayName);
      const takenSlugs = new Set(store.profiles.map((profile) => profile.slug));
      const slug = makeUniqueSlug(slugify(displayName), takenSlugs);
      const profileId = `profile-${randomUUID()}`;
      const userId = `user-${randomUUID()}`;
      const profile = createRegisteredProfile(profileId, displayName, slug, userId);
      const user = createRegisteredUser(
        userId,
        verified.email,
        profile.id,
        verified.googleSubject
      );
      store.profiles.push(profile);
      store.users.push(user);
      resolvedUser = user;
      resolvedProfile = profile;
    }

    if (!resolvedProfile) {
      throw new GoogleAuthError(
        "The linked profile for this user is missing.",
        "profile-missing"
      );
    }

    const mvpWriteAccessToken = `mvp-write-${randomUUID()}`;
    resolvedUser.mvpWriteAccessToken = mvpWriteAccessToken;

    result = {
      user: toPublicUser(resolvedUser),
      profile: resolvedProfile,
      mvpWriteAccessToken,
    };
  });

  if (!result) {
    throw new Error("Google authentication failed.");
  }

  return result;
}
