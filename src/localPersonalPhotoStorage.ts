import {
  assignPersonalLaneIndex,
  deletePhoto,
  getAllPhotos,
  getAllSeries,
  getPhoto,
  savePhoto,
  saveSeries,
  updatePhotoImage,
  updatePhotoMetadata,
  updatePhotoOffsets,
  updatePhotoPreview,
  updatePhotoSeriesId,
  updatePhotoSeriesIds,
} from "./db";
import type {
  PersonalPhotoStorage,
  PhotoRecord,
  PhotoRecordMetadata,
  PhotoTimelineImage,
} from "./personalPhotoStorage";

function toPhotoMetadata(record: PhotoRecord): PhotoRecordMetadata {
  const { imageBlob: _imageBlob, previewBlob, ...metadata } = record;
  return {
    ...metadata,
    hasPreview: !!previewBlob,
  };
}

export function createLocalPersonalPhotoStorage(): PersonalPhotoStorage {
  return {
    assignPersonalLaneIndex,
    deletePhoto,
    async deletePhotosInDay(date: string): Promise<string[]> {
      const photos = await getAllPhotos();
      const ids = photos.filter((photo) => photo.date === date).map((photo) => photo.id);
      await Promise.all(ids.map((id) => deletePhoto(id)));
      return ids;
    },
    getAllPhotos,
    async getAllPhotoMetadata(): Promise<PhotoRecordMetadata[]> {
      const photos = await getAllPhotos();
      return photos.map(toPhotoMetadata);
    },
    getAllSeries,
    getPhoto,
    async getPhotoTimelineImage(id: string): Promise<PhotoTimelineImage | null> {
      const photo = await getPhoto(id);
      if (!photo) return null;
      if (photo.previewBlob) {
        return {
          imageBlob: photo.previewBlob,
          originalBlob: photo.imageBlob,
          previewBlob: photo.previewBlob,
        };
      }
      return {
        imageBlob: photo.imageBlob,
        originalBlob: photo.imageBlob,
      };
    },
    savePhoto,
    saveSeries,
    updatePhotoImage,
    updatePhotoMetadata,
    updatePhotoOffsets,
    updatePhotoPreview,
    updatePhotoSeriesId,
    updatePhotoSeriesIds,
  };
}

export const localPersonalPhotoStorage = createLocalPersonalPhotoStorage();
