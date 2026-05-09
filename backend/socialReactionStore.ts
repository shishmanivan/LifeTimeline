import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  CLOSE_REACTION,
  PART_OF_THIS_REACTION,
  isPhotoReactionType,
  type PhotoReactionType,
} from "../src/photoSocial";

export type PhotoReaction = {
  id: string;
  profileId: string;
  photoId: string;
  userId: string;
  type: PhotoReactionType;
  createdAt: string;
};

export type PhotoReactionCounts = Record<PhotoReactionType, number>;

export type PhotoReactionSummary = {
  counts: PhotoReactionCounts;
  viewerReaction: PhotoReactionType | null;
  viewerReactions: PhotoReactionType[];
};

type SocialReactionStoreData = {
  formatVersion: 1;
  reactions: PhotoReaction[];
};

const DEFAULT_SOCIAL_STORE_PATH = path.resolve(
  process.cwd(),
  ".runtime-data",
  "social-store.json"
);

let updateQueue: Promise<unknown> = Promise.resolve();

function getSocialStorePath(
  envStorePath = process.env.SOCIAL_STORE_PATH
): string {
  const trimmedPath = envStorePath?.trim();
  return trimmedPath ? path.resolve(trimmedPath) : DEFAULT_SOCIAL_STORE_PATH;
}

function buildEmptyStore(): SocialReactionStoreData {
  return {
    formatVersion: 1,
    reactions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReaction(value: unknown): PhotoReaction | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.profileId !== "string" ||
    typeof value.photoId !== "string" ||
    typeof value.userId !== "string" ||
    !isPhotoReactionType(value.type) ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    profileId: value.profileId,
    photoId: value.photoId,
    userId: value.userId,
    type: value.type,
    createdAt: value.createdAt,
  };
}

function normalizeStore(raw: unknown): SocialReactionStoreData {
  if (
    !isRecord(raw) ||
    raw.formatVersion !== 1 ||
    !Array.isArray(raw.reactions)
  ) {
    return buildEmptyStore();
  }

  return {
    formatVersion: 1,
    reactions: raw.reactions.flatMap((reaction) => {
      const normalized = normalizeReaction(reaction);
      return normalized ? [normalized] : [];
    }),
  };
}

async function readSocialReactionStore(
  storePath = getSocialStorePath()
): Promise<SocialReactionStoreData> {
  try {
    const raw = await readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return buildEmptyStore();
    }
    throw error;
  }
}

async function writeSocialReactionStore(
  store: SocialReactionStoreData,
  storePath = getSocialStorePath()
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function buildSummary(
  store: SocialReactionStoreData,
  photoId: string,
  viewerUserId: string | null
): PhotoReactionSummary {
  const reactionUserIds: Record<PhotoReactionType, Set<string>> = {
    close: new Set<string>(),
    partOfThis: new Set<string>(),
  };
  const viewerReactions = new Set<PhotoReactionType>();

  for (const reaction of store.reactions) {
    if (reaction.photoId !== photoId) {
      continue;
    }
    reactionUserIds[reaction.type].add(reaction.userId);
    if (viewerUserId && reaction.userId === viewerUserId) {
      viewerReactions.add(reaction.type);
    }
  }
  const orderedViewerReactions = [CLOSE_REACTION, PART_OF_THIS_REACTION].filter(
    (reactionType) => viewerReactions.has(reactionType)
  );

  return {
    counts: {
      close: reactionUserIds.close.size,
      partOfThis: reactionUserIds.partOfThis.size,
    },
    viewerReaction: orderedViewerReactions[0] ?? null,
    viewerReactions: orderedViewerReactions,
  };
}

function enqueueStoreUpdate<T>(work: () => Promise<T>): Promise<T> {
  const next = updateQueue.then(work, work);
  updateQueue = next.catch(() => undefined);
  return next;
}

export async function readPhotoReactionSummary(
  photoId: string,
  viewerUserId: string | null
): Promise<PhotoReactionSummary> {
  const store = await readSocialReactionStore();
  return buildSummary(store, photoId, viewerUserId);
}

export async function putPhotoReaction(input: {
  profileId: string;
  photoId: string;
  userId: string;
  type: PhotoReactionType;
  createdAt?: string;
}): Promise<PhotoReactionSummary> {
  return await enqueueStoreUpdate(async () => {
    const store = await readSocialReactionStore();
    const existing = store.reactions.find(
      (reaction) =>
        reaction.photoId === input.photoId &&
        reaction.userId === input.userId &&
        reaction.type === input.type
    );

    if (!existing) {
      store.reactions.push({
        id: randomUUID(),
        profileId: input.profileId,
        photoId: input.photoId,
        userId: input.userId,
        type: input.type,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      await writeSocialReactionStore(store);
    }

    return buildSummary(store, input.photoId, input.userId);
  });
}

export async function deletePhotoReaction(input: {
  photoId: string;
  userId: string;
  type: PhotoReactionType;
}): Promise<PhotoReactionSummary> {
  return await enqueueStoreUpdate(async () => {
    const store = await readSocialReactionStore();
    const nextReactions = store.reactions.filter(
      (reaction) =>
        !(
          reaction.photoId === input.photoId &&
          reaction.userId === input.userId &&
          reaction.type === input.type
        )
    );

    if (nextReactions.length !== store.reactions.length) {
      store.reactions = nextReactions;
      await writeSocialReactionStore(store);
    }

    return buildSummary(store, input.photoId, input.userId);
  });
}

export async function putClosePhotoReaction(input: {
  profileId: string;
  photoId: string;
  userId: string;
  createdAt?: string;
}): Promise<PhotoReactionSummary> {
  return await putPhotoReaction({
    ...input,
    type: CLOSE_REACTION,
  });
}

export async function deleteClosePhotoReaction(input: {
  photoId: string;
  userId: string;
}): Promise<PhotoReactionSummary> {
  return await deletePhotoReaction({
    ...input,
    type: CLOSE_REACTION,
  });
}
