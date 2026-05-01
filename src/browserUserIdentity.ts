import type { RegisterUserResult, RememberedBrowserUser } from "./userModel";

const BROWSER_USER_IDENTITY_KEY = "ppy-browser-user";
/** Set only after explicit "Войти как …" (or register/recovery submit). Drives write token + owner UX. */
const BROWSER_ACTIVE_USER_KEY = "ppy-browser-active-user";
const BROWSER_VIEWER_ID_KEY = "ppy-viewer-id";
const BROWSER_VIEWER_COOKIE_NAME = "ppy_viewer_id";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function canUseDocumentCookie(): boolean {
  return typeof document !== "undefined" && typeof document.cookie === "string";
}

function createBrowserViewerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `viewer-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function isValidBrowserViewerId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{16,128}$/.test(value);
}

function readBrowserViewerIdCookie(): string | null {
  if (!canUseDocumentCookie()) return null;
  const cookies = document.cookie.split(";").map((item) => item.trim());
  const prefix = `${BROWSER_VIEWER_COOKIE_NAME}=`;
  const raw = cookies.find((item) => item.startsWith(prefix));
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice(prefix.length));
  return isValidBrowserViewerId(value) ? value : null;
}

function writeBrowserViewerIdCookie(viewerId: string): void {
  if (!canUseDocumentCookie()) return;
  document.cookie = [
    `${BROWSER_VIEWER_COOKIE_NAME}=${encodeURIComponent(viewerId)}`,
    "Max-Age=34560000",
    "Path=/",
    "SameSite=Lax",
  ].join("; ");
}

export function getOrCreateBrowserViewerId(): string {
  const stored = canUseStorage()
    ? window.localStorage.getItem(BROWSER_VIEWER_ID_KEY)
    : null;
  if (isValidBrowserViewerId(stored)) {
    writeBrowserViewerIdCookie(stored);
    return stored;
  }

  const cookieViewerId = readBrowserViewerIdCookie();
  if (cookieViewerId) {
    if (canUseStorage()) {
      window.localStorage.setItem(BROWSER_VIEWER_ID_KEY, cookieViewerId);
    }
    return cookieViewerId;
  }

  const viewerId = createBrowserViewerId();
  if (canUseStorage()) {
    window.localStorage.setItem(BROWSER_VIEWER_ID_KEY, viewerId);
  }
  writeBrowserViewerIdCookie(viewerId);
  return viewerId;
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
