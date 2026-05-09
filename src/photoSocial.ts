export type PhotoReactionType = "close" | "partOfThis";

export type PhotoSocialSettings = {
  reactionsEnabled: boolean;
  allowedReactions: PhotoReactionType[];
};

export const CLOSE_REACTION: PhotoReactionType = "close";
export const PART_OF_THIS_REACTION: PhotoReactionType = "partOfThis";

export const DEFAULT_PHOTO_SOCIAL_SETTINGS: PhotoSocialSettings = {
  reactionsEnabled: false,
  allowedReactions: [],
};

export type PhotoImportSourceMetadata = {
  kind: "imported-photo";
  sourcePhotoId: string;
  sourceProfileId: string;
  sourceProfileSlug: string;
  sourceAuthorName: string;
  copiedAt: string;
  copiedText: boolean;
};

const ALLOWED_PHOTO_REACTIONS = new Set<PhotoReactionType>([
  CLOSE_REACTION,
  PART_OF_THIS_REACTION,
]);

export function isPhotoReactionType(value: unknown): value is PhotoReactionType {
  return typeof value === "string" && ALLOWED_PHOTO_REACTIONS.has(value as PhotoReactionType);
}

export function normalizePhotoSocialSettings(
  value: unknown
): PhotoSocialSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_PHOTO_SOCIAL_SETTINGS };
  }

  const input = value as {
    reactionsEnabled?: unknown;
    allowedReactions?: unknown;
  };
  const allowedReactions = Array.isArray(input.allowedReactions)
    ? Array.from(new Set(input.allowedReactions.filter(isPhotoReactionType)))
    : [];

  const reactionsEnabled = input.reactionsEnabled === true;
  return {
    reactionsEnabled,
    allowedReactions: reactionsEnabled ? allowedReactions : [],
  };
}
