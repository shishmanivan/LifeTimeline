import { localPersonalPhotoStorage } from "./localPersonalPhotoStorage";
import {
  createServerPersonalPhotoStorage,
  type ServerPersonalPhotoStorageOptions,
} from "./serverPersonalPhotoStorage";
import type { PersonalPhotoStorage } from "./personalPhotoStorage";

export type PersonalPhotoStorageMode = "local" | "server";

export type PersonalPhotoCapabilities = {
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

type PersonalPhotoStorageEnv = ImportMetaEnv & {
  readonly VITE_PERSONAL_PHOTO_STORAGE?: string;
  readonly VITE_PERSONAL_PHOTO_API_BASE_URL?: string;
  readonly VITE_PERSONAL_PHOTO_API_BASE_PATH?: string;
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

export function getPersonalPhotoCapabilities(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoCapabilities {
  return getPersonalPhotoStorageMode(env) === "server"
    ? SERVER_PERSONAL_PHOTO_CAPABILITIES
    : LOCAL_PERSONAL_PHOTO_CAPABILITIES;
}

export function createSelectedPersonalPhotoStorage(
  env: PersonalPhotoStorageEnv = import.meta.env as PersonalPhotoStorageEnv
): PersonalPhotoStorage {
  const mode = getPersonalPhotoStorageMode(env);

  if (mode === "server") {
    const options: ServerPersonalPhotoStorageOptions = {
      baseUrl: env.VITE_PERSONAL_PHOTO_API_BASE_URL,
      apiBasePath: env.VITE_PERSONAL_PHOTO_API_BASE_PATH,
      writeToken: env.VITE_PERSONAL_PHOTO_WRITE_TOKEN,
    };
    return createServerPersonalPhotoStorage(options);
  }

  return localPersonalPhotoStorage;
}

export const personalPhotoStorage = createSelectedPersonalPhotoStorage();
export const personalPhotoStorageMode = getPersonalPhotoStorageMode();
export const personalPhotoStorageIsServerMode =
  isPersonalPhotoStorageServerMode();
export const personalPhotoCapabilities = getPersonalPhotoCapabilities();
