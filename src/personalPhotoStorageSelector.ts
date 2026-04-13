import { localPersonalPhotoStorage } from "./localPersonalPhotoStorage";
import {
  createServerPersonalPhotoStorage,
  loadAdminProfiles,
  loadCurrentAuthenticatedUser,
  type ServerProfileDto,
  type ServerPersonalPhotoStorageOptions,
} from "./serverPersonalPhotoStorage";
import type { PersonalPhotoStorage } from "./personalPhotoStorage";
import { getActiveBrowserWriteAccessToken } from "./browserUserIdentity";
import type { UserModel, UserRole } from "./userModel";

export type PersonalPhotoStorageMode = "local" | "server";

export type PersonalPhotoCapabilities = {
  /**
   * Server mode: true when the browser has an active user write token; local mode: always true.
   */
  canWrite: boolean;
  canAdminWrite: boolean;
  canEditMetadata: boolean;
  canEditOffsets: boolean;
  canLinkSeries: boolean;
  canUnlinkSeries: boolean;
  canAddPhoto: boolean;
  canReplacePhoto: boolean;
  canDeletePhoto: boolean;
  canAddPhotoToDay: boolean;
  canDeleteAllPhotosInDay: boolean;
  canImportBackup: boolean;
  canWritePreview: boolean;
};

const DEFAULT_PERSONAL_PHOTO_STORAGE_MODE: PersonalPhotoStorageMode = "local";
const LOCAL_PERSONAL_PHOTO_CAPABILITIES: PersonalPhotoCapabilities = {
  canWrite: true,
  canAdminWrite: true,
  canEditMetadata: true,
  canEditOffsets: true,
  canLinkSeries: true,
  canUnlinkSeries: true,
  canAddPhoto: true,
  canReplacePhoto: true,
  canDeletePhoto: true,
  canAddPhotoToDay: true,
  canDeleteAllPhotosInDay: true,
  canImportBackup: true,
  canWritePreview: true,
};
const SERVER_PERSONAL_PHOTO_CAPABILITIES: PersonalPhotoCapabilities = {
  canWrite: true,
  canAdminWrite: true,
  canEditMetadata: true,
  canEditOffsets: true,
  canLinkSeries: true,
  canUnlinkSeries: true,
  canAddPhoto: true,
  canReplacePhoto: true,
  canDeletePhoto: true,
  canAddPhotoToDay: true,
  canDeleteAllPhotosInDay: true,
  canImportBackup: false,
  canWritePreview: false,
};

const SERVER_USER_PERSONAL_PHOTO_CAPABILITIES: PersonalPhotoCapabilities = {
  canWrite: true,
  canAdminWrite: false,
  canEditMetadata: true,
  canEditOffsets: true,
  canLinkSeries: true,
  canUnlinkSeries: true,
  canAddPhoto: true,
  canReplacePhoto: true,
  canDeletePhoto: true,
  canAddPhotoToDay: true,
  canDeleteAllPhotosInDay: true,
  canImportBackup: false,
  canWritePreview: false,
};

const SERVER_READ_ONLY_PERSONAL_PHOTO_CAPABILITIES: PersonalPhotoCapabilities = {
  canWrite: false,
  canAdminWrite: false,
  canEditMetadata: false,
  canEditOffsets: false,
  canLinkSeries: false,
  canUnlinkSeries: false,
  canAddPhoto: false,
  canReplacePhoto: false,
  canDeletePhoto: false,
  canAddPhotoToDay: false,
  canDeleteAllPhotosInDay: false,
  canImportBackup: false,
  canWritePreview: false,
};

type PersonalPhotoStorageEnv = ImportMetaEnv & {
  readonly VITE_PERSONAL_PHOTO_STORAGE?: string;
  readonly VITE_PERSONAL_PHOTO_API_BASE_URL?: string;
  readonly VITE_PERSONAL_PHOTO_API_BASE_PATH?: string;
};

function normalizeStorageMode(
  rawMode: string | undefined
): PersonalPhotoStorageMode {
  return rawMode === "server" ? "server" : DEFAULT_PERSONAL_PHOTO_STORAGE_MODE;
}

export function getPersonalPhotoStorageMode(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoStorageMode {
  return normalizeStorageMode(env.VITE_PERSONAL_PHOTO_STORAGE);
}

export function isPersonalPhotoStorageServerMode(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): boolean {
  return getPersonalPhotoStorageMode(env) === "server";
}

function getServerPersonalWriteToken(): string | undefined {
  return getActiveBrowserWriteAccessToken() ?? undefined;
}

export function getPersonalPhotoCapabilitiesForAuthenticatedUser(
  authenticatedUser: Pick<UserModel, "role"> | null,
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoCapabilities {
  if (getPersonalPhotoStorageMode(env) !== "server") {
    return LOCAL_PERSONAL_PHOTO_CAPABILITIES;
  }

  const role: UserRole | null = authenticatedUser?.role ?? null;
  if (role === "admin") {
    return SERVER_PERSONAL_PHOTO_CAPABILITIES;
  }

  if (role === "user") {
    return SERVER_USER_PERSONAL_PHOTO_CAPABILITIES;
  }

  return SERVER_READ_ONLY_PERSONAL_PHOTO_CAPABILITIES;
}

export function createSelectedPersonalPhotoStorage(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoStorage {
  const mode = getPersonalPhotoStorageMode(env);

  if (mode === "server") {
    const options: ServerPersonalPhotoStorageOptions = {
      baseUrl: env.VITE_PERSONAL_PHOTO_API_BASE_URL,
      apiBasePath: env.VITE_PERSONAL_PHOTO_API_BASE_PATH,
      writeToken: getServerPersonalWriteToken(),
    };
    return createServerPersonalPhotoStorage(options);
  }

  return localPersonalPhotoStorage;
}

export async function loadSelectedAdminProfiles(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): Promise<ServerProfileDto[]> {
  if (getPersonalPhotoStorageMode(env) !== "server") {
    return [];
  }

  return await loadAdminProfiles({
    baseUrl: env.VITE_PERSONAL_PHOTO_API_BASE_URL,
    writeToken: getServerPersonalWriteToken(),
  });
}

export async function loadAuthenticatedCurrentUser(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): Promise<UserModel | null> {
  if (getPersonalPhotoStorageMode(env) !== "server") {
    return null;
  }

  return await loadCurrentAuthenticatedUser({
    baseUrl: env.VITE_PERSONAL_PHOTO_API_BASE_URL,
    writeToken: getServerPersonalWriteToken(),
  });
}

export const personalPhotoStorage = createSelectedPersonalPhotoStorage();
export const personalPhotoStorageMode = getPersonalPhotoStorageMode();
export const personalPhotoStorageIsServerMode =
  isPersonalPhotoStorageServerMode();
