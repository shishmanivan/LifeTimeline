import type {
  PhotoMetadataUpdate,
  PhotoRecord,
  SeriesRecord,
} from "./db";

export type { PhotoMetadataUpdate, PhotoRecord, SeriesRecord };

export interface PersonalPhotoStorage {
  getAllPhotos(): Promise<PhotoRecord[]>;
  getPhoto(id: string): Promise<PhotoRecord | null>;
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
