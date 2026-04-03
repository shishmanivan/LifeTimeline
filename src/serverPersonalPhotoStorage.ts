import { assignPersonalLaneIndex } from "./db";
import type {
  PersonalPhotoStorage,
  PhotoMetadataUpdate,
  PhotoRecord,
  SeriesRecord,
} from "./personalPhotoStorage";

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
  /** Optional shared secret for protected write endpoints. */
  writeToken?: string;
};

type ServerPhotoFields = {
  id: string;
  title: string;
  date: string;
  type: "personal";
  note?: string;
  offsetY?: number;
  offsetXDays?: number;
  laneIndex?: number;
  showOnTimeline?: boolean;
  seriesId?: string;
};

/**
 * Expected response shape for listing or reading personal photos from the server.
 * The frontend converts these stable server URLs into the `PhotoRecord` blob shape
 * required by the current storage interface.
 */
export type ServerPersonalPhotoDto = ServerPhotoFields & {
  imageUrl: string;
  previewUrl?: string;
};

export type ServerSeriesDto = SeriesRecord;

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
};

export type UpdateServerPhotoSeriesRequest = {
  seriesId: string | null;
};

const DEFAULT_API_BASE_PATH = "/api/personal";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
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
  if (!baseUrl) return joinedPath;
  return `${trimTrailingSlash(baseUrl)}${joinedPath}`;
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
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
    note: photo.note,
    offsetY: photo.offsetY,
    offsetXDays: photo.offsetXDays,
    laneIndex: photo.laneIndex,
    showOnTimeline: photo.showOnTimeline,
    seriesId: photo.seriesId,
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
    imageBlob,
    previewBlob,
    offsetY: dto.offsetY,
    offsetXDays: dto.offsetXDays,
    laneIndex: dto.laneIndex,
    note: dto.note,
    showOnTimeline: dto.showOnTimeline,
    seriesId: dto.seriesId,
  };
}

export function createServerPersonalPhotoStorage(
  options: ServerPersonalPhotoStorageOptions = {}
): PersonalPhotoStorage {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBasePath = options.apiBasePath ?? DEFAULT_API_BASE_PATH;
  const defaultHeaders = options.defaultHeaders ?? {};
  const writeAuthHeaders = getWriteAuthHeaders(options.writeToken);

  const apiUrl = (path: string) => joinApiUrl(options.baseUrl, apiBasePath, path);

  const jsonRequest = (body: unknown): RequestInit => ({
    headers: {
      "Content-Type": "application/json",
      ...defaultHeaders,
      ...writeAuthHeaders,
    },
    body: JSON.stringify(body),
  });

  return {
    async getAllPhotos(): Promise<PhotoRecord[]> {
      const response = await fetchJson<ListServerPersonalPhotosResponse>(
        fetchImpl,
        apiUrl("/photos")
      );
      return await Promise.all(
        response.photos.map((photo) => serverPhotoDtoToPhotoRecord(photo, fetchImpl))
      );
    },

    async getPhoto(id: string): Promise<PhotoRecord | null> {
      const response = await fetchJson<ListServerPersonalPhotosResponse>(
        fetchImpl,
        apiUrl("/photos")
      );
      const photo = response.photos.find((item) => item.id === id);
      if (!photo) return null;
      return await serverPhotoDtoToPhotoRecord(photo, fetchImpl);
    },

    async savePhoto(photo: PhotoRecord): Promise<void> {
      const request: SaveServerPersonalPhotoRequest = {
        metadata: toServerPhotoFields(photo),
        image: photo.imageBlob,
        preview: photo.previewBlob,
      };

      await requestOk(fetchImpl, apiUrl(`/photos/${encodeURIComponent(photo.id)}`), {
        method: "PUT",
        headers: writeAuthHeaders,
        body: buildSavePhotoFormData(request),
      });
    },

    async deletePhoto(id: string): Promise<void> {
      await requestOk(fetchImpl, apiUrl(`/photos/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: writeAuthHeaders,
      });
    },

    async deletePhotosInDay(date: string): Promise<string[]> {
      const response = await fetchJson<DeleteServerPersonalPhotosInDayResponse>(
        fetchImpl,
        apiUrl(`/photos/by-date/${encodeURIComponent(date)}`),
        {
          method: "DELETE",
          headers: writeAuthHeaders,
        }
      );
      return response.deletedPhotoIds;
    },

    async updatePhotoOffsets(
      id: string,
      offsetY: number,
      offsetXDays: number
    ): Promise<void> {
      const body: UpdateServerPhotoOffsetsRequest = { offsetY, offsetXDays };
      await requestOk(
        fetchImpl,
        apiUrl(`/photos/${encodeURIComponent(id)}/metadata`),
        {
          method: "PATCH",
          ...jsonRequest(body),
        }
      );
    },

    async updatePhotoMetadata(
      id: string,
      update: PhotoMetadataUpdate
    ): Promise<void> {
      const body: PatchServerPersonalPhotoMetadataRequest = update;
      await requestOk(
        fetchImpl,
        apiUrl(`/photos/${encodeURIComponent(id)}/metadata`),
        {
          method: "PATCH",
          ...jsonRequest(body),
        }
      );
    },

    async updatePhotoImage(
      id: string,
      imageBlob: Blob,
      previewBlob?: Blob
    ): Promise<void> {
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
        headers: writeAuthHeaders,
        body: formData,
      });
    },

    async updatePhotoPreview(id: string, previewBlob: Blob): Promise<void> {
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
          headers: writeAuthHeaders,
          body: formData,
        }
      );
    },

    async updatePhotoSeriesId(
      id: string,
      seriesId: string | undefined
    ): Promise<void> {
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
    },

    async getAllSeries(): Promise<SeriesRecord[]> {
      const response = await fetchJson<ListServerSeriesResponse>(
        fetchImpl,
        apiUrl("/series")
      );
      return response.series;
    },

    async saveSeries(series: SeriesRecord): Promise<void> {
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
