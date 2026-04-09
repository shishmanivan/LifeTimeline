import { resolvePersonalDataDir } from "./personalDataset";

/**
 * Optional scope for choosing a prepared personal dataset root on disk.
 * MVP: ignored; all scopes resolve to the same directory as today.
 * Future: map profileId (or slug) to per-profile storage under a shared base.
 */
export type PreparedPersonalDatasetScope = {
  profileId?: string;
};

/**
 * Resolve the filesystem directory for a prepared personal dataset (manifest + assets).
 * Pass `scope` when the request is tied to a profile so future per-profile storage can branch here.
 */
export function resolvePreparedPersonalDataDir(
  scope: PreparedPersonalDatasetScope | undefined,
  envDataDir: string | undefined = process.env.PERSONAL_PHOTO_DATA_DIR
): string {
  void scope;
  return resolvePersonalDataDir(envDataDir);
}
