import { getMvpSeededBackendCurrentUser } from "./mvpOwnerContext";

/**
 * Describes a mutating personal API operation. Extend as routes grow.
 * Future: thread authenticated actor + resolved resource profileIds into evaluation.
 */
export type PersonalWriteOperation =
  | { operation: "delete-photos-by-date"; date: string }
  | {
      operation: "upsert-photo";
      photoId: string;
      /** From client metadata; may be absent (server default profile id applies on save). */
      profileId?: string;
    }
  | { operation: "delete-photo"; photoId: string }
  | { operation: "replace-photo-image"; photoId: string }
  | { operation: "patch-photo-metadata"; photoId: string }
  | { operation: "patch-photo-series"; photoId: string }
  | { operation: "upsert-series"; seriesId: string };

export type PersonalWriteOwnershipResult =
  | { allowed: true }
  | { allowed: false; statusCode: number; message: string };

/**
 * MVP: always allows — implicit seeded owner matches current open personal writes.
 * Real auth: resolve actor, load target profile scope, then allow or deny here.
 */
export function evaluatePersonalWriteOwnership(
  ctx: PersonalWriteOperation
): PersonalWriteOwnershipResult {
  void ctx;
  void getMvpSeededBackendCurrentUser();
  return { allowed: true };
}
