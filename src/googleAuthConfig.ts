export const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? "";

export function hasGoogleAuthConfig(): boolean {
  return googleClientId.length > 0;
}