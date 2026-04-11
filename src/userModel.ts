import type { ProfileModel } from "./profileModel";

export type UserStatus = "pending" | "active";

export type UserModel = {
  /** Stable internal user id. */
  id: string;
  email: string;
  status: UserStatus;
  createdAt: string;
  /**
   * Primary owned profile for MVP registration flow.
   * `null` is allowed so future multi-step registration can reserve a user
   * before profile provisioning completes.
   */
  primaryProfileId: string | null;
};

export type RegisterUserInput = {
  email: string;
  displayName: string;
  requestedSlug?: string;
};

export type RecoverAccessInput = {
  email: string;
};

export type RequestRecoveryCodeInput = {
  email: string;
};

export type RequestRecoveryCodeResult = {
  ok: true;
  delivery: "server-log";
};

export type VerifyRecoveryCodeInput = {
  email: string;
  code: string;
};

export type RegisterUserResult = {
  user: UserModel;
  profile: ProfileModel;
  /**
   * MVP-only browser-held write token.
   * Convenience bridge for same-browser editing, not production auth.
   */
  mvpWriteAccessToken: string;
};

export type RememberedBrowserUser = {
  userId: string;
  email: string;
  primaryProfileId: string | null;
  profileSlug: string;
  profileDisplayName: string;
  mvpWriteAccessToken?: string;
  registeredAt: string;
};
