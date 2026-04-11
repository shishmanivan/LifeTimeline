import { localPersonalPhotoStorage } from "./localPersonalPhotoStorage";
import {
  createServerPersonalPhotoStorage,
  loadAdminProfiles,
  type ServerProfileDto,
  type ServerPersonalPhotoStorageOptions,
} from "./serverPersonalPhotoStorage";
import type { PersonalPhotoStorage } from "./personalPhotoStorage";
import { getActiveBrowserWriteAccessToken } from "./browserUserIdentity";

export type PersonalPhotoStorageMode = "local" | "server";

export type PersonalPhotoCapabilities = {
  /**
   * Server mode: true when admin env token exists, or when the user explicitly signed in
   * (active browser session with mvpWriteAccessToken). Local mode: always true.
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
  canLinkSeries: false,
  canUnlinkSeries: false,
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
  /** Preferred; aligns with backend PERSONAL_WRITE_TOKEN */
  readonly VITE_PERSONAL_WRITE_TOKEN?: string;
  readonly VITE_PERSONAL_PHOTO_WRITE_TOKEN?: string;
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

function getServerPersonalWriteToken(
  env: PersonalPhotoStorageEnv
): string | undefined {
  const fromBrowserIdentity = getActiveBrowserWriteAccessToken();
  const fromPreferred = env.VITE_PERSONAL_WRITE_TOKEN?.trim();
  const fromLegacy = env.VITE_PERSONAL_PHOTO_WRITE_TOKEN?.trim();
  return fromBrowserIdentity || fromPreferred || fromLegacy || undefined;
}

function getServerAdminWriteToken(
  env: PersonalPhotoStorageEnv
): string | undefined {
  const fromPreferred = env.VITE_PERSONAL_WRITE_TOKEN?.trim();
  const fromLegacy = env.VITE_PERSONAL_PHOTO_WRITE_TOKEN?.trim();
  return fromPreferred || fromLegacy || undefined;
}

export function getPersonalPhotoCapabilities(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoCapabilities {
  if (getPersonalPhotoStorageMode(env) !== "server") {
    return LOCAL_PERSONAL_PHOTO_CAPABILITIES;
  }
  const activeUserToken = getActiveBrowserWriteAccessToken();
  if (activeUserToken) {
    return SERVER_USER_PERSONAL_PHOTO_CAPABILITIES;
  }
  const adminToken = getServerAdminWriteToken(env);
  if (adminToken) {
    return SERVER_PERSONAL_PHOTO_CAPABILITIES;
  }
  return getServerPersonalWriteToken(env)
    ? SERVER_USER_PERSONAL_PHOTO_CAPABILITIES
    : SERVER_READ_ONLY_PERSONAL_PHOTO_CAPABILITIES;
}

export function createSelectedPersonalPhotoStorage(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoStorage {
  const mode = getPersonalPhotoStorageMode(env);

  if (mode === "server") {
    const options: ServerPersonalPhotoStorageOptions = {
      baseUrl: env.VITE_PERSONAL_PHOTO_API_BASE_URL,
      apiBasePath: env.VITE_PERSONAL_PHOTO_API_BASE_PATH,
      writeToken: getServerPersonalWriteToken(env),
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
    writeToken: getServerAdminWriteToken(env),
  });
}

export const personalPhotoStorage = createSelectedPersonalPhotoStorage();
export const personalPhotoStorageMode = getPersonalPhotoStorageMode();
export const personalPhotoStorageIsServerMode =
  isPersonalPhotoStorageServerMode();
export const personalPhotoCapabilities = getPersonalPhotoCapabilities();
