import { resolvePersonalDataDir } from "./personalDataset";
import path from "node:path";

/**
 * Optional scope for choosing a prepared personal dataset root on disk.
 * Legacy profiles omit `dirName` and keep using the shared dataset directory.
 */
export type PreparedPersonalDatasetScope = {
  profileId?: string;
  dirName?: string;
};

export function createUserDatasetDirName(userId: string): string {
  return userId;
}

function assertSafeDatasetDirName(dirName: string): string {
  const trimmed = dirName.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    path.basename(trimmed) !== trimmed ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
  ) {
    throw new Error(`Invalid personal dataset directory name "${dirName}".`);
  }

  return trimmed;
}

export function resolvePersonalDataRootDir(
  envRootDir: string | undefined = process.env.PERSONAL_PHOTO_DATA_ROOT_DIR,
  envDataDir: string | undefined = process.env.PERSONAL_PHOTO_DATA_DIR
): string {
  return envRootDir
    ? path.resolve(envRootDir)
    : path.dirname(resolvePersonalDataDir(envDataDir));
}

/**
 * Resolve the filesystem directory for a prepared personal dataset (manifest + assets).
 * Pass `scope` when the request is tied to a profile so future per-profile storage can branch here.
 */
export function resolvePreparedPersonalDataDir(
  scope: PreparedPersonalDatasetScope | undefined,
  envDataDir: string | undefined = process.env.PERSONAL_PHOTO_DATA_DIR,
  envRootDir: string | undefined = process.env.PERSONAL_PHOTO_DATA_ROOT_DIR
): string {
  if (scope?.dirName) {
    return path.join(
      resolvePersonalDataRootDir(envRootDir, envDataDir),
      assertSafeDatasetDirName(scope.dirName)
    );
  }

  return resolvePersonalDataDir(envDataDir);
}
