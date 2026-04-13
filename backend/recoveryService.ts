import { randomInt, randomUUID } from "node:crypto";
import {
  normalizeUserRole,
  type RequestRecoveryCodeInput,
  type RequestRecoveryCodeResult,
  type RegisterUserResult,
  type VerifyRecoveryCodeInput,
} from "../src/userModel";
import { updateIdentityStore } from "./identityStore";

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
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateRecoveryCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function requestRecoveryCode(
  input: RequestRecoveryCodeInput
): Promise<RequestRecoveryCodeResult> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    throw new RecoveryError("A valid email is required.", "invalid-input");
  }

  let result: RequestRecoveryCodeResult | null = null;

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
    if (!user.primaryProfileId) {
      throw new RecoveryError(
        "This user does not have a recoverable profile yet.",
        "profile-missing"
      );
    }

    const recoveryCode = generateRecoveryCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RECOVERY_CODE_TTL_MS).toISOString();

    store.users[userIndex] = {
      ...user,
      recoveryChallenge: {
        code: recoveryCode,
        requestedAt: now.toISOString(),
        expiresAt,
      },
    };

    console.log(
      `[personal-backend] recovery code for ${email}: ${recoveryCode} (expires ${expiresAt})`
    );

    result = {
      ok: true,
      delivery: "server-log",
    };
  });

  if (!result) {
    throw new Error("Recovery code request failed.");
  }

  return result;
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
    if (!user.primaryProfileId) {
      throw new RecoveryError(
        "This user does not have a recoverable profile yet.",
        "profile-missing"
      );
    }

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

    const profile = store.profiles.find(
      (item) => item.id === user.primaryProfileId
    );
    if (!profile) {
      throw new RecoveryError(
        "The linked profile for this user is missing.",
        "profile-missing"
      );
    }

    const mvpWriteAccessToken = `mvp-write-${randomUUID()}`;
    store.users[userIndex] = {
      ...user,
      mvpWriteAccessToken,
      recoveryChallenge: undefined,
    };

    result = {
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        createdAt: user.createdAt,
        role: normalizeUserRole(user.role),
        primaryProfileId: user.primaryProfileId,
      },
      profile,
      mvpWriteAccessToken,
    };
  });

  if (!result) {
    throw new Error("Recovery verification failed.");
  }

  return result;
}
