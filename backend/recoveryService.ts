import { randomInt, randomUUID } from "node:crypto";
import type { ProfileModel } from "../src/profileModel";
import { getProfileDatasetProfileId } from "../src/profileModel";
import {
  normalizeUserRole,
  type RequestRecoveryCodeInput,
  type RequestRecoveryCodeResult,
  type RegisterUserResult,
  type VerifyRecoveryCodeInput,
} from "../src/userModel";
import { updateIdentityStore } from "./identityStore";
import { ensurePreparedPersonalDataset } from "./personalDataset";
import {
  createUserDatasetDirName,
  resolvePreparedPersonalDataDir,
} from "./personalDatasetResolver";
import {
  isRecoveryEmailConfigured,
  sendRecoveryCodeEmail,
} from "./recoveryEmail";

const RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;

export class RecoveryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid-input"
      | "not-found"
      | "profile-missing"
      | "invalid-code"
      | "expired-code"
      | "email-delivery-failed",
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "RecoveryError";
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateRecoveryCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
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

function deriveDisplayName(email: string): string {
  const emailLocalPart = normalizeEmail(email).split("@")[0] ?? "Profile";
  return emailLocalPart || "Profile";
}

function createRegisteredProfile(
  profileId: string,
  displayName: string,
  slug: string,
  ownerUserId: string,
  datasetDirName: string
): ProfileModel {
  return {
    id: profileId,
    ownerUserId,
    slug,
    displayName,
    availability: "public",
    personalDataset: {
      profileId,
      dirName: datasetDirName,
    },
  };
}

function findProfileForUser(
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

export async function requestRecoveryCode(
  input: RequestRecoveryCodeInput
): Promise<RequestRecoveryCodeResult> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    throw new RecoveryError("A valid email is required.", "invalid-input");
  }

  let recoveryCode = "";
  let expiresAt = "";

  await updateIdentityStore((store) => {
    const userIndex = store.users.findIndex(
      (user) => normalizeEmail(user.email) === email
    );
    recoveryCode = generateRecoveryCode();
    const now = new Date();
    expiresAt = new Date(now.getTime() + RECOVERY_CODE_TTL_MS).toISOString();
    const recoveryChallenge = {
      code: recoveryCode,
      requestedAt: now.toISOString(),
      expiresAt,
    };

    if (userIndex < 0) {
      store.users.push({
        id: `user-${randomUUID()}`,
        email,
        status: "pending",
        createdAt: now.toISOString(),
        role: "user",
        primaryProfileId: null,
        recoveryChallenge,
      });
      return;
    }

    const user = store.users[userIndex];

    store.users[userIndex] = {
      ...user,
      recoveryChallenge,
    };
  });

  const useEmail = isRecoveryEmailConfigured();
  if (useEmail) {
    try {
      await sendRecoveryCodeEmail({
        to: email,
        code: recoveryCode,
        expiresAtIso: expiresAt,
      });
    } catch (cause) {
      throw new RecoveryError(
        "Could not deliver the recovery code by email. Please try again later.",
        "email-delivery-failed",
        { cause }
      );
    }
    console.log(
      `[personal-backend] recovery code email sent for ${email} (expires ${expiresAt})`
    );
    return { ok: true, delivery: "email" };
  }

  console.log(
    `[personal-backend] recovery code for ${email}: ${recoveryCode} (expires ${expiresAt})`
  );
  return { ok: true, delivery: "server-log" };
}

export async function verifyRecoveryCode(
  input: VerifyRecoveryCodeInput
): Promise<RegisterUserResult> {
  const email = normalizeEmail(input.email);
  const code = input.code.trim();
  if (!email || !email.includes("@")) {
    throw new RecoveryError("A valid email is required.", "invalid-input");
  }
  if (!code) {
    throw new RecoveryError("A recovery code is required.", "invalid-input");
  }

  let result: RegisterUserResult | null = null;

  await updateIdentityStore((store) => {
    const userIndex = store.users.findIndex(
      (user) => normalizeEmail(user.email) === email
    );
    if (userIndex < 0) {
      throw new RecoveryError(
        "No registered user was found for this email.",
        "not-found"
      );
    }

    const user = store.users[userIndex];
    const challenge = user.recoveryChallenge;
    if (!challenge || challenge.code !== code) {
      throw new RecoveryError(
        "The recovery code is invalid.",
        "invalid-code"
      );
    }

    if (Date.parse(challenge.expiresAt) < Date.now()) {
      store.users[userIndex] = {
        ...user,
        recoveryChallenge: undefined,
      };
      throw new RecoveryError(
        "The recovery code has expired.",
        "expired-code"
      );
    }

    let profile = findProfileForUser(store.profiles, user.primaryProfileId);
    let primaryProfileId = user.primaryProfileId;
    if (!profile && !primaryProfileId) {
      const displayName = deriveDisplayName(user.email);
      const takenSlugs = new Set(store.profiles.map((item) => item.slug));
      const slug = makeUniqueSlug(slugify(displayName), takenSlugs);
      const profileId = `profile-${randomUUID()}`;
      const datasetDirName = createUserDatasetDirName(user.id);
      profile = createRegisteredProfile(
        profileId,
        displayName,
        slug,
        user.id,
        datasetDirName
      );
      store.profiles.push(profile);
      primaryProfileId = profile.id;
    }

    if (!profile) {
      throw new RecoveryError(
        "The linked profile for this user is missing.",
        "profile-missing"
      );
    }

    const mvpWriteAccessToken = `mvp-write-${randomUUID()}`;
    store.users[userIndex] = {
      ...user,
      status: "active",
      primaryProfileId,
      mvpWriteAccessToken,
      recoveryChallenge: undefined,
    };

    result = {
      user: {
        id: user.id,
        email: user.email,
        status: "active",
        createdAt: user.createdAt,
        role: normalizeUserRole(user.role),
        primaryProfileId,
      },
      profile,
      mvpWriteAccessToken,
    };
  });

  const completedRecovery = result as RegisterUserResult | null;
  if (!completedRecovery) {
    throw new Error("Recovery verification failed.");
  }

  await ensurePreparedPersonalDataset(
    resolvePreparedPersonalDataDir(completedRecovery.profile.personalDataset)
  );

  return completedRecovery;
}
