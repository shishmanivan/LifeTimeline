import type {
  PhotoMetadataUpdate,
  PhotoRecord,
  SeriesRecord,
} from "./db";

export type { PhotoMetadataUpdate, PhotoRecord, SeriesRecord };

export type PhotoRecordMetadata = Omit<PhotoRecord, "imageBlob" | "previewBlob"> & {
  hasPreview?: boolean;
};

export type PhotoTimelineImage = {
  imageBlob: Blob;
  originalBlob?: Blob;
  previewBlob?: Blob;
};

export interface PersonalPhotoStorage {
  getAllPhotos(): Promise<PhotoRecord[]>;
  getAllPhotoMetadata(): Promise<PhotoRecordMetadata[]>;
  getPhoto(id: string): Promise<PhotoRecord | null>;
  getPhotoTimelineImage(id: string): Promise<PhotoTimelineImage | null>;
  savePhoto(photo: PhotoRecord): Promise<void>;
  deletePhoto(id: string): Promise<void>;
  deletePhotosInDay(date: string): Promise<string[]>;
  updatePhotoOffsets(
    id: string,
    offsetY: number,
    offsetXDays: number
  ): Promise<void>;
  updatePhotoMetadata(
    id: string,
    update: PhotoMetadataUpdate
  ): Promise<void>;
  updatePhotoImage(
    id: string,
    imageBlob: Blob,
    previewBlob?: Blob
  ): Promise<void>;
  updatePhotoPreview(id: string, previewBlob: Blob): Promise<void>;
  updatePhotoSeriesId(
    id: string,
    seriesId: string | undefined
  ): Promise<void>;
  getAllSeries(): Promise<SeriesRecord[]>;
  saveSeries(series: SeriesRecord): Promise<void>;
  assignPersonalLaneIndex(records: PhotoRecord[]): PhotoRecord[];
}
