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
} from "./db";
import type { PersonalPhotoStorage } from "./personalPhotoStorage";

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
    getAllSeries,
    getPhoto,
    savePhoto,
    saveSeries,
    updatePhotoImage,
    updatePhotoMetadata,
    updatePhotoOffsets,
    updatePhotoPreview,
    updatePhotoSeriesId,
  };
}

export const localPersonalPhotoStorage = createLocalPersonalPhotoStorage();
