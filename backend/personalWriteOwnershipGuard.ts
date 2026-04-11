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

type PersonalWriteTarget =
  | {
      targetProfileId?: string | null;
      actorProfileId?: string | null;
      actorKind?: "admin" | "user";
    }
  | undefined;

function allowActorProfileOnly(target: PersonalWriteTarget): PersonalWriteOwnershipResult {
  const actorProfileId = target?.actorProfileId ?? null;
  const targetProfileId = target?.targetProfileId ?? actorProfileId;
  if (
    actorProfileId !== null &&
    targetProfileId !== null &&
    actorProfileId === targetProfileId
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    statusCode: 403,
    message: "Write access is limited to the current user's profile.",
  };
}

/**
 * MVP: token-gated writes are restricted to the actor's own profile.
 * Admin token still exists, but only acts as the seeded owner profile actor.
 * Real auth: resolve actor + target resources and replace this with real authorization.
 */
export function evaluatePersonalWriteOwnership(
  ctx: PersonalWriteOperation,
  options?: {
    targetProfileId?: string | null;
    actorProfileId?: string | null;
    actorKind?: "admin" | "user";
  }
): PersonalWriteOwnershipResult {
  void getMvpSeededBackendCurrentUser();

  switch (ctx.operation) {
    case "upsert-photo":
      return allowActorProfileOnly({
        targetProfileId: ctx.profileId ?? options?.targetProfileId,
        actorProfileId: options?.actorProfileId,
        actorKind: options?.actorKind,
      });
    case "delete-photo":
    case "replace-photo-image":
    case "patch-photo-metadata":
      return allowActorProfileOnly(options);
    case "patch-photo-series":
      return options?.actorKind === "admin"
        ? allowActorProfileOnly(options)
        : {
            allowed: false,
            statusCode: 403,
            message: "Series editing is not available in user MVP mode.",
          };
    case "delete-photos-by-date":
      return allowActorProfileOnly(options);
    case "upsert-series":
      return options?.actorKind === "admin"
        ? allowActorProfileOnly(options)
        : {
            allowed: false,
            statusCode: 403,
            message: "Series editing is not available in user MVP mode.",
          };
    default:
      return {
        allowed: false,
        statusCode: 403,
        message: "Unsupported personal write operation.",
      };
  }
}
