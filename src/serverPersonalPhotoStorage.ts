import { getActiveBrowserWriteAccessToken } from "./browserUserIdentity";
import { assignPersonalLaneIndex } from "./db";
import type {
  PersonalPhotoStorage,
  PhotoRecordMetadata,
  PhotoTimelineImage,
  PhotoMetadataUpdate,
  PhotoRecord,
  SeriesRecord,
} from "./personalPhotoStorage";
import type { ProfileModel } from "./profileModel";
import {
  CLOSE_REACTION,
  PART_OF_THIS_REACTION,
  normalizePhotoSocialSettings,
  type PhotoImportSourceMetadata,
  type PhotoReactionType,
  type PhotoSocialSettings,
} from "./photoSocial";
import type {
  CurrentAuthenticatedUserResult,
  GoogleAuthInput,
  RequestRecoveryCodeInput,
  RequestRecoveryCodeResult,
  RegisterUserInput,
  RegisterUserResult,
  UserModel,
  VerifyRecoveryCodeInput,
} from "./userModel";
import { getRouteProfileSlug } from "./profileRouteState";

type FetchLike = typeof fetch;
const PERSONAL_WRITE_TOKEN_HEADER = "X-Personal-Write-Token";

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

export type ServerPersonalPhotoStorageOptions = {
  /** Optional absolute server origin, e.g. https://example.com */
  baseUrl?: string;
  /** API prefix on that origin. Defaults to /api/personal */
  apiBasePath?: string;
  /** Useful for tests or later dependency injection. */
  fetchImpl?: FetchLike;
  /** Optional headers applied to JSON requests. */
  defaultHeaders?: HeadersInit;
  /** Optional shared secret for protected write endpoints (otherwise read from browser each request). */
  writeToken?: string;
  /** When set, invoked at the start of each mutating operation; throw to block writes. */
  assertWriteAllowed?: () => void;
};

type ServerPhotoFields = {
  id: string;
  title: string;
  date: string;
  type: "personal";
  profileId?: string;
  note?: string;
  offsetY?: number;
  offsetXDays?: number;
  laneIndex?: number;
  showOnTimeline?: boolean;
  seriesId?: string;
  seriesReminder?: boolean;
  social?: PhotoSocialSettings;
  source?: PhotoImportSourceMetadata;
};

/**
 * Expected response shape for listing or reading personal photos from the server.
 * The frontend converts these stable server URLs into the `PhotoRecord` blob shape
 * required by the current storage interface.
 */
export type ServerPersonalPhotoDto = ServerPhotoFields & {
  profileId: string;
  social: PhotoSocialSettings;
  imageUrl: string;
  previewUrl?: string;
};

export type ServerSeriesDto = SeriesRecord;
export type ServerProfileDto = ProfileModel & {
  accountCreatedAt?: string | null;
  photoCount?: number;
};
export type ListAdminProfilesResponse = {
  profiles: ServerProfileDto[];
};

export type GetCurrentAuthenticatedUserResponse = CurrentAuthenticatedUserResult;

export type ListServerPersonalPhotosResponse = {
  photos: ServerPersonalPhotoDto[];
};

export type GetServerPersonalPhotoResponse = {
  photo: ServerPersonalPhotoDto;
};

export type ListServerSeriesResponse = {
  series: ServerSeriesDto[];
};

export type DeleteServerPersonalPhotosInDayResponse = {
  deletedPhotoIds: string[];
};

export type RecordPhotoViewResponse = {
  ok: boolean;
  photoId: string;
  countedUnique: boolean;
  stats: {
    uniqueAccountViews: number;
    uniqueGuestViews: number;
    uniqueViews: number;
    rawOpens: number;
  };
};

export type PhotoViewStats = RecordPhotoViewResponse["stats"];

export type GetPhotoViewStatsResponse = {
  photoId: string;
  stats: PhotoViewStats;
};

export type PhotoReactionCounts = Record<PhotoReactionType, number>;

export type GetPhotoReactionsResponse = {
  counts: PhotoReactionCounts;
  viewerReaction: PhotoReactionType | null;
  viewerReactions: PhotoReactionType[];
  reactionsEnabled: boolean;
  allowedReactions: PhotoReactionType[];
};

export type ImportPhotoToMyTimelineRequest = {
  includeText: boolean;
  includeAllPhotosOfDay: boolean;
};

export type ImportPhotoToMyTimelineResponse = {
  created: ServerPersonalPhotoDto[];
  skipped: ServerPersonalPhotoDto[];
};

/**
 * Expected multipart body for creating/upserting a full personal photo record.
 * `metadata` is sent as JSON, `image` is the original blob, `preview` is optional.
 */
export type SaveServerPersonalPhotoRequest = {
  metadata: ServerPhotoFields;
  image: Blob;
  preview?: Blob;
};

export type UpdateServerPhotoOffsetsRequest = {
  offsetY: number;
  offsetXDays: number;
};

export type PatchServerPersonalPhotoMetadataRequest = {
  title?: string;
  date?: string;
  note?: string;
  offsetY?: number;
  offsetXDays?: number;
  seriesReminder?: boolean;
  social?: PhotoSocialSettings;
};

export type UpdateServerPhotoSeriesRequest = {
  seriesId: string | null;
};

const DEFAULT_API_BASE_PATH = "/api/personal";
const DEFAULT_PROFILE_ID = "1";
const ENV_API_BASE_URL =
  (import.meta.env.VITE_PERSONAL_PHOTO_API_BASE_URL as string | undefined)?.trim() ||
  undefined;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

function getApiBaseUrl(baseUrl: string | undefined): string {
  const resolved = baseUrl?.trim() || ENV_API_BASE_URL;
  if (!resolved) {
    throw new Error("VITE_PERSONAL_PHOTO_API_BASE_URL is required for server photo storage.");
  }

  return trimTrailingSlash(resolved);
}

function buildAbsoluteApiUrl(baseUrl: string | undefined, path: string): string {
  return `${getApiBaseUrl(baseUrl)}/${trimLeadingSlash(path)}`;
}

function joinApiUrl(
  baseUrl: string | undefined,
  apiBasePath: string,
  path: string
): string {
  const joinedPath = `/${trimLeadingSlash(apiBasePath)}/${trimLeadingSlash(path)}`.replace(
    /\/{2,}/g,
    "/"
  );
  return buildAbsoluteApiUrl(baseUrl, joinedPath);
}

export async function loadProfileForCurrentRoute(
  options: Pick<ServerPersonalPhotoStorageOptions, "baseUrl" | "fetchImpl"> = {}
): Promise<ServerProfileDto | null> {
  if (typeof window === "undefined") {
    return null;
  }

  const profileSlug = getRouteProfileSlug(window.location.pathname);
  if (!profileSlug) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    joinApiUrl(options.baseUrl, "", `/api/profile/${encodeURIComponent(profileSlug)}`)
  );
  if (!response.ok) {
    return null;
  }

  return (await response.json()) as ServerProfileDto;
}

export async function loadAdminProfiles(
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<ServerProfileDto[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchJson<ListAdminProfilesResponse>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/admin/profiles"),
    {
      headers: getWriteAuthHeaders(options.writeToken),
    }
  );
  return response.profiles;
}

export async function loadCurrentAuthenticatedUser(
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<UserModel | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchJson<GetCurrentAuthenticatedUserResponse>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/me"),
    {
      headers: getWriteAuthHeaders(options.writeToken),
    }
  );
  return response.user;
}

export async function registerUserViaServer(
  input: RegisterUserInput,
  options: Pick<ServerPersonalPhotoStorageOptions, "baseUrl" | "fetchImpl"> = {}
): Promise<RegisterUserResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return await fetchJson<RegisterUserResult>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/register"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
}

export async function requestRecoveryCodeViaServer(
  input: RequestRecoveryCodeInput,
  options: Pick<ServerPersonalPhotoStorageOptions, "baseUrl" | "fetchImpl"> = {}
): Promise<RequestRecoveryCodeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return await fetchJson<RequestRecoveryCodeResult>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/recover-access/request-code"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
}

export async function verifyRecoveryCodeViaServer(
  input: VerifyRecoveryCodeInput,
  options: Pick<ServerPersonalPhotoStorageOptions, "baseUrl" | "fetchImpl"> = {}
): Promise<RegisterUserResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return await fetchJson<RegisterUserResult>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/recover-access/verify-code"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
}

export async function authenticateWithGoogleViaServer(
  input: GoogleAuthInput,
  options: Pick<ServerPersonalPhotoStorageOptions, "baseUrl" | "fetchImpl"> = {}
): Promise<RegisterUserResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return await fetchJson<RegisterUserResult>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/auth/google"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
}

export async function recordPhotoViewViaServer(
  photoId: string,
  viewerId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<RecordPhotoViewResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  return await fetchJson<RecordPhotoViewResponse>(
    fetchImpl,
    joinApiUrl(
      options.baseUrl,
      "",
      `/api/photo-views/photos/${encodeURIComponent(photoId)}`
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getWriteAuthHeaders(writeToken),
      },
      body: JSON.stringify({ viewerId }),
    }
  );
}

export async function getPhotoViewStatsViaServer(
  photoId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<PhotoViewStats> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  const response = await fetchJson<GetPhotoViewStatsResponse>(
    fetchImpl,
    joinApiUrl(
      options.baseUrl,
      "",
      `/api/photo-views/photos/${encodeURIComponent(photoId)}`
    ),
    {
      headers: getWriteAuthHeaders(writeToken),
    }
  );
  return response.stats;
}

export async function getPhotoReactionsViaServer(
  photoId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  return await fetchJson<GetPhotoReactionsResponse>(
    fetchImpl,
    joinApiUrl(
      options.baseUrl,
      "",
      `/api/social/photos/${encodeURIComponent(photoId)}/reactions`
    ),
    {
      headers: getWriteAuthHeaders(writeToken),
    }
  );
}

export async function putPhotoReactionViaServer(
  photoId: string,
  reactionType: PhotoReactionType,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  return await fetchJson<GetPhotoReactionsResponse>(
    fetchImpl,
    joinApiUrl(
      options.baseUrl,
      "",
      `/api/social/photos/${encodeURIComponent(photoId)}/reactions/${reactionType}`
    ),
    {
      method: "PUT",
      headers: getWriteAuthHeaders(writeToken),
    }
  );
}

export async function deletePhotoReactionViaServer(
  photoId: string,
  reactionType: PhotoReactionType,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  return await fetchJson<GetPhotoReactionsResponse>(
    fetchImpl,
    joinApiUrl(
      options.baseUrl,
      "",
      `/api/social/photos/${encodeURIComponent(photoId)}/reactions/${reactionType}`
    ),
    {
      method: "DELETE",
      headers: getWriteAuthHeaders(writeToken),
    }
  );
}

export async function putClosePhotoReactionViaServer(
  photoId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  return await putPhotoReactionViaServer(photoId, CLOSE_REACTION, options);
}

export async function deleteClosePhotoReactionViaServer(
  photoId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  return await deletePhotoReactionViaServer(photoId, CLOSE_REACTION, options);
}

export async function putPartOfThisPhotoReactionViaServer(
  photoId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  return await putPhotoReactionViaServer(photoId, PART_OF_THIS_REACTION, options);
}

export async function deletePartOfThisPhotoReactionViaServer(
  photoId: string,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<GetPhotoReactionsResponse> {
  return await deletePhotoReactionViaServer(photoId, PART_OF_THIS_REACTION, options);
}

export async function importPhotoToMyTimeline(
  photoId: string,
  input: ImportPhotoToMyTimelineRequest,
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<ImportPhotoToMyTimelineResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  return await fetchJson<ImportPhotoToMyTimelineResponse>(
    fetchImpl,
    joinApiUrl(
      options.baseUrl,
      "",
      `/api/personal/photos/${encodeURIComponent(photoId)}/import`
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getWriteAuthHeaders(writeToken),
      },
      body: JSON.stringify(input),
    }
  );
}

/**
 * Lists photos for the authenticated user's primary profile from `GET /api/personal/photos`,
 * regardless of which public profile route is open in the browser.
 */
export async function fetchAuthenticatedUserPersonalPhotos(
  options: Pick<
    ServerPersonalPhotoStorageOptions,
    "baseUrl" | "fetchImpl" | "writeToken"
  > = {}
): Promise<ListServerPersonalPhotosResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeToken = options.writeToken ?? getActiveBrowserWriteAccessToken();
  return await fetchJson<ListServerPersonalPhotosResponse>(
    fetchImpl,
    joinApiUrl(options.baseUrl, "", "/api/personal/photos"),
    {
      headers: getWriteAuthHeaders(writeToken),
    }
  );
}

export function collectImportedSourcePhotoIdsFromDtos(
  photos: readonly ServerPersonalPhotoDto[]
): Set<string> {
  const ids = new Set<string>();
  for (const photo of photos) {
    const s = photo.source;
    if (
      s &&
      s.kind === "imported-photo" &&
      typeof s.sourcePhotoId === "string" &&
      s.sourcePhotoId.length > 0
    ) {
      ids.add(s.sourcePhotoId);
    }
  }
  return ids;
}

function getPhotosListUrl(
  baseUrl: string | undefined,
  apiBasePath: string
): string {
  if (typeof window !== "undefined") {
    const profileSlug = getRouteProfileSlug(window.location.pathname);
    if (profileSlug) {
      return joinApiUrl(baseUrl, "", `/api/profile/${encodeURIComponent(profileSlug)}/photos`);
    }
  }

  return joinApiUrl(baseUrl, apiBasePath, "/photos");
}

async function fetchPhotosListResponse(
  fetchImpl: FetchLike,
  baseUrl: string | undefined,
  apiBasePath: string
): Promise<ListServerPersonalPhotosResponse> {
  if (typeof window !== "undefined") {
    const profileSlug = getRouteProfileSlug(window.location.pathname);
    if (profileSlug) {
      const profileResponse = await fetchImpl(
        joinApiUrl(baseUrl, "", `/api/profile/${encodeURIComponent(profileSlug)}`)
      );
      if (!profileResponse.ok) {
        return { photos: [] };
      }

      return await fetchJson<ListServerPersonalPhotosResponse>(
        fetchImpl,
        joinApiUrl(baseUrl, "", `/api/profile/${encodeURIComponent(profileSlug)}/photos`)
      );
    }
  }

  return await fetchJson<ListServerPersonalPhotosResponse>(
    fetchImpl,
    getPhotosListUrl(baseUrl, apiBasePath)
  );
}

async function readErrorText(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`;
  if (response.status === 413) {
    return `${fallback}: Upload is too large for the server (likely nginx \`client_max_body_size\`).`;
  }
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      const parsed = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };
      const errorCode = typeof parsed.error === "string" ? parsed.error : "";
      const message = typeof parsed.message === "string" ? parsed.message : "";
      if (errorCode && message) {
        return `${fallback}: ${errorCode}: ${message}`;
      }
      if (message) {
        return `${fallback}: ${message}`;
      }
      if (errorCode) {
        return `${fallback}: ${errorCode}`;
      }
    }

    const text = await response.text();
    return text ? `${fallback}: ${text}` : fallback;
  } catch {
    return fallback;
  }
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(await readErrorText(response));
  }
  return response;
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  input: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetchImpl(input, init);
  await ensureOk(response);
  return (await response.json()) as T;
}

async function fetchBlob(
  fetchImpl: FetchLike,
  input: string,
  init?: RequestInit
): Promise<Blob> {
  const response = await fetchImpl(input, init);
  await ensureOk(response);
  return await response.blob();
}

async function requestOk(
  fetchImpl: FetchLike,
  input: string,
  init?: RequestInit
): Promise<void> {
  const response = await fetchImpl(input, init);
  await ensureOk(response);
}

function getWriteAuthHeaders(writeToken: string | undefined): HeadersInit | undefined {
  if (!writeToken) return undefined;
  return {
    [PERSONAL_WRITE_TOKEN_HEADER]: writeToken,
  };
}

function toServerPhotoFields(photo: PhotoRecord): ServerPhotoFields {
  return {
    id: photo.id,
    title: photo.title,
    date: photo.date,
    type: "personal",
    profileId: photo.profileId ?? DEFAULT_PROFILE_ID,
    note: photo.note,
    offsetY: photo.offsetY,
    offsetXDays: photo.offsetXDays,
    laneIndex: photo.laneIndex,
    showOnTimeline: photo.showOnTimeline,
    seriesId: photo.seriesId,
    seriesReminder: photo.seriesReminder,
    social: normalizePhotoSocialSettings(photo.social),
    source: photo.source,
  };
}

function appendBlob(
  formData: FormData,
  name: string,
  blob: Blob,
  filename: string
): void {
  formData.append(name, blob, filename);
}

function getBlobUploadFileName(blob: Blob, fallbackBaseName: string): string {
  if (typeof File !== "undefined" && blob instanceof File && blob.name) {
    return blob.name;
  }

  const extension = MIME_TYPE_EXTENSIONS[blob.type] ?? ".bin";
  return `${fallbackBaseName}${extension}`;
}

function buildSavePhotoFormData(
  request: SaveServerPersonalPhotoRequest
): FormData {
  const formData = new FormData();
  formData.append("metadata", JSON.stringify(request.metadata));
  appendBlob(
    formData,
    "image",
    request.image,
    getBlobUploadFileName(request.image, `${request.metadata.id}-image`)
  );
  if (request.preview) {
    appendBlob(
      formData,
      "preview",
      request.preview,
      getBlobUploadFileName(request.preview, `${request.metadata.id}-preview`)
    );
  }
  return formData;
}

async function serverPhotoDtoToPhotoRecord(
  dto: ServerPersonalPhotoDto,
  fetchImpl: FetchLike
): Promise<PhotoRecord> {
  const imageBlob = await fetchBlob(fetchImpl, dto.imageUrl);
  const previewBlob = dto.previewUrl
    ? await fetchBlob(fetchImpl, dto.previewUrl)
    : undefined;

  return {
    id: dto.id,
    title: dto.title,
    date: dto.date,
    type: "personal",
    profileId: dto.profileId ?? DEFAULT_PROFILE_ID,
    imageBlob,
    previewBlob,
    offsetY: dto.offsetY,
    offsetXDays: dto.offsetXDays,
    laneIndex: dto.laneIndex,
    note: dto.note,
    showOnTimeline: dto.showOnTimeline,
    seriesId: dto.seriesId,
    seriesReminder: dto.seriesReminder,
    social: normalizePhotoSocialSettings(dto.social),
    source: dto.source,
  };
}

function serverPhotoDtoToPhotoMetadata(dto: ServerPersonalPhotoDto): PhotoRecordMetadata {
  return {
    id: dto.id,
    title: dto.title,
    date: dto.date,
    type: "personal",
    profileId: dto.profileId ?? DEFAULT_PROFILE_ID,
    offsetY: dto.offsetY,
    offsetXDays: dto.offsetXDays,
    laneIndex: dto.laneIndex,
    note: dto.note,
    showOnTimeline: dto.showOnTimeline,
    seriesId: dto.seriesId,
    seriesReminder: dto.seriesReminder,
    social: normalizePhotoSocialSettings(dto.social),
    hasPreview: !!dto.previewUrl,
    source: dto.source,
  };
}

async function serverPhotoDtoToTimelineImage(
  dto: ServerPersonalPhotoDto,
  fetchImpl: FetchLike
): Promise<PhotoTimelineImage> {
  const url = dto.previewUrl ?? dto.imageUrl;
  const imageBlob = await fetchBlob(fetchImpl, url);
  return {
    imageBlob,
    originalBlob: dto.previewUrl ? undefined : imageBlob,
    previewBlob: dto.previewUrl ? imageBlob : undefined,
  };
}

export function createServerPersonalPhotoStorage(
  options: ServerPersonalPhotoStorageOptions = {}
): PersonalPhotoStorage {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBasePath = options.apiBasePath ?? DEFAULT_API_BASE_PATH;
  const defaultHeaders = options.defaultHeaders ?? {};

  const resolveWriteToken = (): string | undefined =>
    (options.writeToken ?? getActiveBrowserWriteAccessToken()) ?? undefined;

  const resolveWriteAuthHeaders = (): HeadersInit | undefined =>
    getWriteAuthHeaders(resolveWriteToken());

  const ensureWriteAllowed = (): void => {
    options.assertWriteAllowed?.();
  };

  const apiUrl = (path: string) => joinApiUrl(options.baseUrl, apiBasePath, path);
  let photoListCache: Promise<ListServerPersonalPhotosResponse> | null = null;

  const getPhotoList = (): Promise<ListServerPersonalPhotosResponse> => {
    photoListCache ??= fetchPhotosListResponse(
      fetchImpl,
      options.baseUrl,
      apiBasePath
    );
    return photoListCache;
  };

  const clearPhotoListCache = (): void => {
    photoListCache = null;
  };

  const jsonRequest = (body: unknown): RequestInit => ({
    headers: {
      "Content-Type": "application/json",
      ...defaultHeaders,
      ...resolveWriteAuthHeaders(),
    },
    body: JSON.stringify(body),
  });

  return {
    async getAllPhotos(): Promise<PhotoRecord[]> {
      const response = await getPhotoList();
      return await Promise.all(
        response.photos.map((photo) => serverPhotoDtoToPhotoRecord(photo, fetchImpl))
      );
    },

    async getAllPhotoMetadata(): Promise<PhotoRecordMetadata[]> {
      const response = await getPhotoList();
      return response.photos.map(serverPhotoDtoToPhotoMetadata);
    },

    async getPhoto(id: string): Promise<PhotoRecord | null> {
      const response = await getPhotoList();
      const photo = response.photos.find((item) => item.id === id);
      if (!photo) return null;
      return await serverPhotoDtoToPhotoRecord(photo, fetchImpl);
    },

    async getPhotoTimelineImage(id: string): Promise<PhotoTimelineImage | null> {
      const response = await getPhotoList();
      const photo = response.photos.find((item) => item.id === id);
      if (!photo) return null;
      return await serverPhotoDtoToTimelineImage(photo, fetchImpl);
    },

    async savePhoto(photo: PhotoRecord): Promise<void> {
      ensureWriteAllowed();
      const request: SaveServerPersonalPhotoRequest = {
        metadata: toServerPhotoFields(photo),
        image: photo.imageBlob,
        preview: photo.previewBlob,
      };

      await requestOk(fetchImpl, apiUrl(`/photos/${encodeURIComponent(photo.id)}`), {
        method: "PUT",
        headers: resolveWriteAuthHeaders(),
        body: buildSavePhotoFormData(request),
      });
      clearPhotoListCache();
    },

    async deletePhoto(id: string): Promise<void> {
      ensureWriteAllowed();
      await requestOk(fetchImpl, apiUrl(`/photos/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: resolveWriteAuthHeaders(),
      });
      clearPhotoListCache();
    },

    async deletePhotosInDay(date: string): Promise<string[]> {
      ensureWriteAllowed();
      const response = await fetchJson<DeleteServerPersonalPhotosInDayResponse>(
        fetchImpl,
        apiUrl(`/photos/by-date/${encodeURIComponent(date)}`),
        {
          method: "DELETE",
          headers: resolveWriteAuthHeaders(),
        }
      );
      clearPhotoListCache();
      return response.deletedPhotoIds;
    },

    async updatePhotoOffsets(
      id: string,
      offsetY: number,
      offsetXDays: number
    ): Promise<void> {
      ensureWriteAllowed();
      const body: UpdateServerPhotoOffsetsRequest = { offsetY, offsetXDays };
      await requestOk(
        fetchImpl,
        apiUrl(`/photos/${encodeURIComponent(id)}/metadata`),
        {
          method: "PATCH",
          ...jsonRequest(body),
        }
      );
      clearPhotoListCache();
    },

    async updatePhotoMetadata(
      id: string,
      update: PhotoMetadataUpdate
    ): Promise<void> {
      ensureWriteAllowed();
      const body: PatchServerPersonalPhotoMetadataRequest = update;
      await requestOk(
        fetchImpl,
        apiUrl(`/photos/${encodeURIComponent(id)}/metadata`),
        {
          method: "PATCH",
          ...jsonRequest(body),
        }
      );
      clearPhotoListCache();
    },

    async updatePhotoImage(
      id: string,
      imageBlob: Blob,
      previewBlob?: Blob
    ): Promise<void> {
      ensureWriteAllowed();
      const formData = new FormData();
      appendBlob(
        formData,
        "image",
        imageBlob,
        getBlobUploadFileName(imageBlob, `${id}-image`)
      );
      if (previewBlob) {
        appendBlob(
          formData,
          "preview",
          previewBlob,
          getBlobUploadFileName(previewBlob, `${id}-preview`)
        );
      }

      await requestOk(fetchImpl, apiUrl(`/photos/${encodeURIComponent(id)}/image`), {
        method: "PUT",
        headers: resolveWriteAuthHeaders(),
        body: formData,
      });
      clearPhotoListCache();
    },

    async updatePhotoPreview(id: string, previewBlob: Blob): Promise<void> {
      ensureWriteAllowed();
      const formData = new FormData();
      appendBlob(
        formData,
        "preview",
        previewBlob,
        getBlobUploadFileName(previewBlob, `${id}-preview`)
      );

      await requestOk(
        fetchImpl,
        apiUrl(`/photos/${encodeURIComponent(id)}/preview`),
        {
          method: "PUT",
          headers: resolveWriteAuthHeaders(),
          body: formData,
        }
      );
      clearPhotoListCache();
    },

    async updatePhotoSeriesId(
      id: string,
      seriesId: string | undefined
    ): Promise<void> {
      ensureWriteAllowed();
      const body: UpdateServerPhotoSeriesRequest = {
        seriesId: seriesId ?? null,
      };
      await requestOk(
        fetchImpl,
        apiUrl(`/photos/${encodeURIComponent(id)}/series`),
        {
          method: "PATCH",
          ...jsonRequest(body),
        }
      );
      clearPhotoListCache();
    },

    async getAllSeries(): Promise<SeriesRecord[]> {
      const response = await fetchJson<ListServerSeriesResponse>(
        fetchImpl,
        apiUrl("/series")
      );
      return response.series;
    },

    async saveSeries(series: SeriesRecord): Promise<void> {
      ensureWriteAllowed();
      await requestOk(
        fetchImpl,
        apiUrl(`/series/${encodeURIComponent(series.id)}`),
        {
          method: "PUT",
          ...jsonRequest(series),
        }
      );
    },

    assignPersonalLaneIndex(records: PhotoRecord[]): PhotoRecord[] {
      return assignPersonalLaneIndex(records);
    },
  };
}

export const serverPersonalPhotoStorage =
  createServerPersonalPhotoStorage();
export { PERSONAL_WRITE_TOKEN_HEADER };
