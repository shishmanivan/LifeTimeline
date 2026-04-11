import type { RegisterUserResult, RememberedBrowserUser } from "./userModel";

const BROWSER_USER_IDENTITY_KEY = "ppy-browser-user";
/** Set only after explicit "Войти как …" (or register/recovery submit). Drives write token + owner UX. */
const BROWSER_ACTIVE_USER_KEY = "ppy-browser-active-user";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function saveRememberedBrowserUser(
  result: RegisterUserResult
): RememberedBrowserUser | null {
  if (!canUseStorage()) return null;

  const remembered: RememberedBrowserUser = {
    userId: result.user.id,
    email: result.user.email,
    primaryProfileId: result.user.primaryProfileId,
    profileSlug: result.profile.slug,
    profileDisplayName: result.profile.displayName,
    mvpWriteAccessToken: result.mvpWriteAccessToken,
    registeredAt: new Date().toISOString(),
  };

  window.localStorage.setItem(
    BROWSER_USER_IDENTITY_KEY,
    JSON.stringify(remembered)
  );
  return remembered;
}

export function loadRememberedBrowserUser(): RememberedBrowserUser | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(BROWSER_USER_IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedBrowserUser;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.profileSlug !== "string" ||
      typeof parsed.profileDisplayName !== "string" ||
      typeof parsed.registeredAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getRememberedBrowserWriteAccessToken(): string | undefined {
  const rememberedUser = loadRememberedBrowserUser();
  const token = rememberedUser?.mvpWriteAccessToken?.trim();
  return token || undefined;
}

export function saveActiveBrowserUser(user: RememberedBrowserUser): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(BROWSER_ACTIVE_USER_KEY, JSON.stringify(user));
}

export function loadActiveBrowserUser(): RememberedBrowserUser | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(BROWSER_ACTIVE_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedBrowserUser;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.profileSlug !== "string" ||
      typeof parsed.profileDisplayName !== "string" ||
      typeof parsed.registeredAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Used for server write requests: only after explicit login (active session). */
export function getActiveBrowserWriteAccessToken(): string | undefined {
  const active = loadActiveBrowserUser();
  const token = active?.mvpWriteAccessToken?.trim();
  return token || undefined;
}

export function clearActiveBrowserUser(): void {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(BROWSER_ACTIVE_USER_KEY);
}

export function clearRememberedBrowserUser(): void {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(BROWSER_USER_IDENTITY_KEY);
}
