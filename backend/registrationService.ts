import { randomUUID } from "node:crypto";
import type { ProfileModel } from "../src/profileModel";
import type {
  RegisterUserInput,
  RegisterUserResult,
  UserModel,
} from "../src/userModel";
import { updateIdentityStore } from "./identityStore";

export class RegistrationError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid-input" | "conflict"
  ) {
    super(message);
    this.name = "RegistrationError";
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

function deriveDisplayName(input: RegisterUserInput): string {
  const displayName = input.displayName.trim();
  if (displayName) return displayName;

  const emailLocalPart = normalizeEmail(input.email).split("@")[0] ?? "Profile";
  return emailLocalPart || "Profile";
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

function createRegisteredProfile(
  profileId: string,
  displayName: string,
  slug: string
): ProfileModel {
  return {
    id: profileId,
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
  primaryProfileId: string
): UserModel {
  return {
    id: userId,
    email,
    status: "active",
    createdAt: new Date().toISOString(),
    primaryProfileId,
  };
}

export async function registerUser(
  input: RegisterUserInput
): Promise<RegisterUserResult> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    throw new RegistrationError("A valid email is required.", "invalid-input");
  }

  if (typeof input.displayName !== "string") {
    throw new RegistrationError(
      "Display name must be a string.",
      "invalid-input"
    );
  }

  const requestedBaseSlug = slugify(input.requestedSlug?.trim() || "");
  const displayName = deriveDisplayName(input);

  let result: RegisterUserResult | null = null;

  await updateIdentityStore((store) => {
    const existingUser = store.users.find(
      (user) => normalizeEmail(user.email) === email
    );
    if (existingUser) {
      throw new RegistrationError(
        "A user with this email already exists.",
        "conflict"
      );
    }

    const takenSlugs = new Set(store.profiles.map((profile) => profile.slug));
    const baseSlug =
      requestedBaseSlug !== "profile"
        ? requestedBaseSlug
        : slugify(displayName || email.split("@")[0] || "profile");
    const slug = makeUniqueSlug(baseSlug, takenSlugs);
    const profileId = `profile-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const mvpWriteAccessToken = `mvp-write-${randomUUID()}`;

    const profile = createRegisteredProfile(profileId, displayName, slug);
    const user = createRegisteredUser(userId, email, profile.id);

    store.profiles.push(profile);
    store.users.push({
      ...user,
      mvpWriteAccessToken,
    });
    result = { user, profile, mvpWriteAccessToken };
  });

  if (!result) {
    throw new Error("Registration failed.");
  }

  return result;
}
