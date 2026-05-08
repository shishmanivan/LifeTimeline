import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CLOSE_REACTION, type PhotoReactionType } from "../src/photoSocial";

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
    value.type !== CLOSE_REACTION ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    profileId: value.profileId,
    photoId: value.photoId,
    userId: value.userId,
    type: CLOSE_REACTION,
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
  const closeUserIds = new Set<string>();
  let viewerReaction: PhotoReactionType | null = null;

  for (const reaction of store.reactions) {
    if (reaction.photoId !== photoId || reaction.type !== CLOSE_REACTION) {
      continue;
    }
    closeUserIds.add(reaction.userId);
    if (viewerUserId && reaction.userId === viewerUserId) {
      viewerReaction = CLOSE_REACTION;
    }
  }

  return {
    counts: {
      close: closeUserIds.size,
    },
    viewerReaction,
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

export async function putClosePhotoReaction(input: {
  profileId: string;
  photoId: string;
  userId: string;
  createdAt?: string;
}): Promise<PhotoReactionSummary> {
  return await enqueueStoreUpdate(async () => {
    const store = await readSocialReactionStore();
    const existing = store.reactions.find(
      (reaction) =>
        reaction.photoId === input.photoId &&
        reaction.userId === input.userId &&
        reaction.type === CLOSE_REACTION
    );

    if (!existing) {
      store.reactions.push({
        id: randomUUID(),
        profileId: input.profileId,
        photoId: input.photoId,
        userId: input.userId,
        type: CLOSE_REACTION,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      await writeSocialReactionStore(store);
    }

    return buildSummary(store, input.photoId, input.userId);
  });
}

export async function deleteClosePhotoReaction(input: {
  photoId: string;
  userId: string;
}): Promise<PhotoReactionSummary> {
  return await enqueueStoreUpdate(async () => {
    const store = await readSocialReactionStore();
    const nextReactions = store.reactions.filter(
      (reaction) =>
        !(
          reaction.photoId === input.photoId &&
          reaction.userId === input.userId &&
          reaction.type === CLOSE_REACTION
        )
    );

    if (nextReactions.length !== store.reactions.length) {
      store.reactions = nextReactions;
      await writeSocialReactionStore(store);
    }

    return buildSummary(store, input.photoId, input.userId);
  });
}
