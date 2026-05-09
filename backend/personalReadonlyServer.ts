import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import {
  getProfileBySlug,
  getProfileDatasetScope,
  listProfilesForAdmin,
} from "./profiles";
import {
  deletePreparedPhotosInDay,
  deletePreparedPhoto,
  ensurePreparedPersonalDataset,
  importPreparedPhotos,
  readPreparedPhotoProfileId,
  readPreparedPhotoProfileIdsInDay,
  readPreparedPhotoSocialRecord,
  readPreparedPersonalDataset,
  readPreparedSeries,
  replacePreparedPhotoImage,
  resolveAssetFilePath,
  savePreparedPhoto,
  savePreparedSeries,
  type PreparedPhotoUpsertMetadata,
  updatePreparedPhotoMetadata,
  updatePreparedPhotoSeries,
  type PreparedUploadedAsset,
  type PreparedPhotoMetadataPatch,
  type PreparedSeriesPatch,
  type PersonalAssetKind,
  type PreparedPhotoSocialRecord,
} from "./personalDataset";
import {
  resolvePreparedPersonalDataDir,
  type PreparedPersonalDatasetScope,
} from "./personalDatasetResolver";
import {
  ensureIdentityStore,
  readIdentityStore,
} from "./identityStore";
import {
  registerUser,
  RegistrationError,
} from "./registrationService";
import {
  requestRecoveryCode,
  verifyRecoveryCode,
  RecoveryError,
} from "./recoveryService";
import {
  authenticateWithGoogle,
  GoogleAuthError,
} from "./googleAuthService";
import {
  readPhotoViewStats,
  recordPhotoView,
  type PhotoViewIdentity,
} from "./photoViewStore";
import {
  deleteClosePhotoReaction,
  putClosePhotoReaction,
  readPhotoReactionSummary,
} from "./socialReactionStore";
import type { ProfileModel } from "../src/profileModel";
import { getProfileDatasetProfileId, isProfileAvailable } from "../src/profileModel";
import type {
  CurrentAuthenticatedUserResult,
  GoogleAuthInput,
  RecoverAccessInput,
  RegisterUserInput,
  RequestRecoveryCodeInput,
  UserModel,
  VerifyRecoveryCodeInput,
} from "../src/userModel";
import {
  CLOSE_REACTION,
  isPhotoReactionType,
  normalizePhotoSocialSettings,
  type PhotoSocialSettings,
} from "../src/photoSocial";
import { getAuthenticatedUserFromRequest } from "./auth/getAuthenticatedUser";
import { mayUserAdmin, mayUserWriteProfile } from "./auth/mayUserWriteProfile";

type PersonalReadonlyServerConfig = {
  host: string;
  port: number;
  publicBaseUrl?: string;
};

type SocialPhotoReactionResponse = {
  counts: {
    close: number;
  };
  viewerReaction: "close" | null;
  reactionsEnabled: boolean;
  allowedReactions: "close"[];
};

type SocialPhotoLookupResult = {
  photo: PreparedPhotoSocialRecord;
  dataDir: string;
};

type ImportPhotoRequest = {
  includeText: boolean;
  includeAllPhotosOfDay: boolean;
};

type ImportSourcePhotoLookupResult = {
  profile: ProfileModel;
  dataDir: string;
};

function personalPreparedDatasetDir(
  scope?: PreparedPersonalDatasetScope
): string {
  return resolvePreparedPersonalDataDir(scope);
}

function personalAssetBasePath(scope?: PreparedPersonalDatasetScope): string {
  return scope?.dirName
    ? `/api/personal/assets/${encodeURIComponent(scope.dirName)}`
    : "/api/personal/assets";
}

function profileDatasetDir(profile: Pick<ProfileModel, "personalDataset">): string {
  return personalPreparedDatasetDir(getProfileDatasetScope(profile));
}

function profileAssetBasePath(
  profile: Pick<ProfileModel, "personalDataset">
): string {
  return personalAssetBasePath(getProfileDatasetScope(profile));
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function getConfig(): PersonalReadonlyServerConfig {
  const rawPort = process.env.PERSONAL_PHOTO_SERVER_PORT;
  const parsedPort = rawPort ? Number(rawPort) : DEFAULT_PORT;

  return {
    host: process.env.PERSONAL_PHOTO_SERVER_HOST || DEFAULT_HOST,
    port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT,
    publicBaseUrl: process.env.PERSONAL_PHOTO_PUBLIC_BASE_URL,
  };
}

function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Personal-Write-Token"
  );
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  applyCors(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  message: string
): void {
  applyCors(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

function isWriteMethod(method: string | undefined): boolean {
  return method === "PUT" || method === "PATCH" || method === "DELETE";
}

async function resolveProfileByAnyProfileId(
  profileId: string | null | undefined
): Promise<ProfileModel | null> {
  if (!profileId) {
    return null;
  }

  const store = await readIdentityStore();
  return (
    store.profiles.find(
      (profile) =>
        profile.id === profileId ||
        getProfileDatasetProfileId(profile) === profileId
    ) ?? null
  );
}

async function getAuthenticatedPrimaryProfile(
  authUser: UserModel | null
): Promise<ProfileModel | null> {
  return await resolveProfileByAnyProfileId(authUser?.primaryProfileId);
}

async function findPreparedPhotoForSocial(
  photoId: string
): Promise<SocialPhotoLookupResult | null> {
  const store = await readIdentityStore();
  const candidateDirs = new Set<string>();
  for (const profile of store.profiles) {
    candidateDirs.add(profileDatasetDir(profile));
  }
  candidateDirs.add(personalPreparedDatasetDir());

  for (const dataDir of candidateDirs) {
    const photo = await readPreparedPhotoSocialRecord(dataDir, photoId);
    if (photo) {
      return { photo, dataDir };
    }
  }

  return null;
}

function getAllowedSocialReactions(
  photo: Pick<PreparedPhotoSocialRecord, "social">
): "close"[] {
  const social = normalizePhotoSocialSettings(photo.social);
  return social.reactionsEnabled && social.allowedReactions.includes(CLOSE_REACTION)
    ? [CLOSE_REACTION]
    : [];
}

function areCloseReactionsAllowed(
  photo: Pick<PreparedPhotoSocialRecord, "social">
): boolean {
  return getAllowedSocialReactions(photo).includes(CLOSE_REACTION);
}

async function buildSocialPhotoReactionResponse(
  photo: PreparedPhotoSocialRecord,
  authUser: UserModel | null
): Promise<SocialPhotoReactionResponse> {
  const allowedReactions = getAllowedSocialReactions(photo);
  const reactionsEnabled = allowedReactions.includes(CLOSE_REACTION);
  if (!reactionsEnabled) {
    return {
      counts: { close: 0 },
      viewerReaction: null,
      reactionsEnabled: false,
      allowedReactions: [],
    };
  }

  const summary = await readPhotoReactionSummary(photo.id, authUser?.id ?? null);
  return {
    counts: summary.counts,
    viewerReaction: summary.viewerReaction,
    reactionsEnabled: true,
    allowedReactions,
  };
}

function readWriteDatasetDirForProfile(profile: ProfileModel): string {
  return profileDatasetDir(profile);
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".jfif":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function getPublicBaseUrl(
  req: IncomingMessage,
  configuredBaseUrl: string | undefined
): string {
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/+$/, "");

  const protoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(protoHeader)
    ? protoHeader[0]
    : protoHeader;
  const hostHeader = req.headers["x-forwarded-host"] ?? req.headers.host;
  const forwardedHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const protocol = forwardedProto || "http";
  const host = forwardedHost || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  return `${protocol}://${host}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePhotoSocialSettings(value: unknown): PhotoSocialSettings {
  if (!isRecord(value)) {
    throw new Error('Field "social" must be an object.');
  }
  if (typeof value.reactionsEnabled !== "boolean") {
    throw new Error('Field "social.reactionsEnabled" must be a boolean.');
  }
  if (!Array.isArray(value.allowedReactions)) {
    throw new Error('Field "social.allowedReactions" must be an array.');
  }

  const allowedReactions = value.allowedReactions.map((reaction) => {
    if (!isPhotoReactionType(reaction)) {
      throw new Error(`Unsupported photo reaction "${String(reaction)}".`);
    }
    return reaction;
  });

  return {
    reactionsEnabled: value.reactionsEnabled,
    allowedReactions: value.reactionsEnabled
      ? Array.from(new Set(allowedReactions))
      : [],
  };
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("Request body is required.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function parsePhotoMetadataPatch(body: unknown): PreparedPhotoMetadataPatch {
  if (!isRecord(body)) {
    throw new Error("Metadata patch must be a JSON object.");
  }

  const patch: PreparedPhotoMetadataPatch = {};
  const allowedKeys = new Set([
    "title",
    "date",
    "note",
    "offsetY",
    "offsetXDays",
    "seriesReminder",
    "social",
  ]);

  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported metadata field "${key}".`);
    }
  }

  if ("title" in body) {
    if (typeof body.title !== "string") {
      throw new Error("Field \"title\" must be a string.");
    }
    const title = body.title.trim();
    if (!title) {
      throw new Error("Field \"title\" cannot be empty.");
    }
    patch.title = title;
  }

  if ("date" in body) {
    if (typeof body.date !== "string" || !isValidDateOnly(body.date)) {
      throw new Error("Field \"date\" must be in YYYY-MM-DD format.");
    }
    patch.date = body.date;
  }

  if ("note" in body) {
    if (typeof body.note !== "string") {
      throw new Error("Field \"note\" must be a string.");
    }
    patch.note = body.note;
  }

  if ("offsetY" in body) {
    if (typeof body.offsetY !== "number" || !Number.isFinite(body.offsetY)) {
      throw new Error("Field \"offsetY\" must be a finite number.");
    }
    patch.offsetY = body.offsetY;
  }

  if ("offsetXDays" in body) {
    if (
      typeof body.offsetXDays !== "number" ||
      !Number.isFinite(body.offsetXDays)
    ) {
      throw new Error("Field \"offsetXDays\" must be a finite number.");
    }
    patch.offsetXDays = body.offsetXDays;
  }

  if ("seriesReminder" in body) {
    if (typeof body.seriesReminder !== "boolean") {
      throw new Error('Field "seriesReminder" must be a boolean.');
    }
    patch.seriesReminder = body.seriesReminder;
  }

  if ("social" in body) {
    patch.social = parsePhotoSocialSettings(body.social);
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("At least one metadata field is required.");
  }

  return patch;
}

function parseSeriesRecord(
  body: unknown,
  pathSeriesId: string
): { id: string; title: string; profileId?: string } {
  if (!isRecord(body)) {
    throw new Error("Series body must be a JSON object.");
  }

  if (typeof body.id !== "string" || !body.id.trim()) {
    throw new Error('Field "id" must be a non-empty string.');
  }
  if (body.id !== pathSeriesId) {
    throw new Error('Series id in body must match the request path.');
  }
  if (typeof body.title !== "string") {
    throw new Error('Field "title" must be a string.');
  }

  const title = body.title.trim();
  if (!title) {
    throw new Error('Field "title" cannot be empty.');
  }

  if ("profileId" in body && typeof body.profileId !== "string") {
    throw new Error('Field "profileId" must be a string when provided.');
  }

  return {
    id: body.id,
    title,
    profileId: typeof body.profileId === "string" ? body.profileId : undefined,
  };
}

function parsePhotoSeriesPatch(body: unknown): PreparedSeriesPatch {
  if (!isRecord(body)) {
    throw new Error("Series patch must be a JSON object.");
  }

  const allowedKeys = new Set(["seriesId"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported series field "${key}".`);
    }
  }

  if (!("seriesId" in body)) {
    throw new Error('Field "seriesId" is required.');
  }

  if (body.seriesId !== null && typeof body.seriesId !== "string") {
    throw new Error('Field "seriesId" must be a string or null.');
  }

  if (typeof body.seriesId === "string" && !body.seriesId.trim()) {
    throw new Error('Field "seriesId" cannot be empty.');
  }

  return {
    seriesId: body.seriesId,
  };
}

function parseRegisterUserInput(body: unknown): RegisterUserInput {
  if (!isRecord(body)) {
    throw new RegistrationError(
      "Registration body must be a JSON object.",
      "invalid-input"
    );
  }

  if (typeof body.email !== "string") {
    throw new RegistrationError(
      'Field "email" must be a string.',
      "invalid-input"
    );
  }

  if (typeof body.displayName !== "string") {
    throw new RegistrationError(
      'Field "displayName" must be a string.',
      "invalid-input"
    );
  }

  if (
    "requestedSlug" in body &&
    body.requestedSlug != null &&
    typeof body.requestedSlug !== "string"
  ) {
    throw new RegistrationError(
      'Field "requestedSlug" must be a string when provided.',
      "invalid-input"
    );
  }

  return {
    email: body.email,
    displayName: body.displayName,
    requestedSlug:
      typeof body.requestedSlug === "string" ? body.requestedSlug : undefined,
  };
}

function parseRecoverAccessInput(body: unknown): RecoverAccessInput {
  if (!isRecord(body)) {
    throw new RecoveryError(
      "Recovery body must be a JSON object.",
      "invalid-input"
    );
  }

  if (typeof body.email !== "string") {
    throw new RecoveryError(
      'Field "email" must be a string.',
      "invalid-input"
    );
  }

  return {
    email: body.email,
  };
}

function parseRequestRecoveryCodeInput(body: unknown): RequestRecoveryCodeInput {
  return parseRecoverAccessInput(body);
}

function parseVerifyRecoveryCodeInput(body: unknown): VerifyRecoveryCodeInput {
  if (!isRecord(body)) {
    throw new RecoveryError(
      "Recovery verification body must be a JSON object.",
      "invalid-input"
    );
  }

  if (typeof body.email !== "string") {
    throw new RecoveryError(
      'Field "email" must be a string.',
      "invalid-input"
    );
  }

  if (typeof body.code !== "string") {
    throw new RecoveryError(
      'Field "code" must be a string.',
      "invalid-input"
    );
  }

  return {
    email: body.email,
    code: body.code,
  };
}

function parseGoogleAuthInput(body: unknown): GoogleAuthInput {
  if (!isRecord(body)) {
    throw new GoogleAuthError(
      "Google auth body must be a JSON object.",
      "invalid-input"
    );
  }

  if (typeof body.credential !== "string") {
    throw new GoogleAuthError(
      'Field "credential" must be a string.',
      "invalid-input"
    );
  }

  return {
    credential: body.credential,
  };
}

function parsePhotoViewIdentity(
  body: unknown,
  authUser: UserModel | null
): PhotoViewIdentity {
  if (!isRecord(body)) {
    throw new Error("Photo view body must be a JSON object.");
  }

  const viewerId =
    typeof body.viewerId === "string" ? body.viewerId.trim() : undefined;
  if (viewerId && !/^[a-zA-Z0-9._:-]{16,128}$/.test(viewerId)) {
    throw new Error('Field "viewerId" has an invalid format.');
  }

  if (authUser) {
    return {
      type: "account",
      userId: authUser.id,
      viewerId,
    };
  }

  if (!viewerId) {
    throw new Error('Field "viewerId" must be a string.');
  }

  return {
    type: "anonymous",
    viewerId,
  };
}

function parseImportPhotoRequest(body: unknown): ImportPhotoRequest {
  if (!isRecord(body)) {
    throw new Error("Import body must be a JSON object.");
  }
  const allowedKeys = new Set(["includeText", "includeAllPhotosOfDay"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported import field "${key}".`);
    }
  }
  if (typeof body.includeText !== "boolean") {
    throw new Error('Field "includeText" must be a boolean.');
  }
  if (typeof body.includeAllPhotosOfDay !== "boolean") {
    throw new Error('Field "includeAllPhotosOfDay" must be a boolean.');
  }
  return {
    includeText: body.includeText,
    includeAllPhotosOfDay: body.includeAllPhotosOfDay,
  };
}

async function findVisibleSourcePhotoProfile(
  photoId: string
): Promise<ImportSourcePhotoLookupResult | null> {
  const store = await readIdentityStore();
  for (const profile of store.profiles) {
    if (!isProfileAvailable(profile)) {
      continue;
    }
    const dataDir = profileDatasetDir(profile);
    const dataset = await readPreparedPersonalDataset(
      dataDir,
      profileAssetBasePath(profile)
    );
    const datasetProfileId = getProfileDatasetProfileId(profile);
    if (
      dataset.photosResponse.photos.some(
        (photo) => photo.id === photoId && photo.profileId === datasetProfileId
      )
    ) {
      return { profile, dataDir };
    }
  }

  return null;
}

async function getSourceAuthorName(sourceProfile: ProfileModel): Promise<string> {
  const store = await readIdentityStore();
  const sourceOwner = store.users.find((user) => user.id === sourceProfile.ownerUserId);
  return (
    sourceProfile.displayName?.trim() ||
    sourceOwner?.email?.trim() ||
    "Unknown author"
  );
}

async function readMultipartFormData(req: IncomingMessage): Promise<FormData> {
  const contentTypeHeader = req.headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;

  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().includes("multipart/form-data")
  ) {
    throw new Error("Expected multipart/form-data request body.");
  }

  const response = new Response(Readable.toWeb(req) as ReadableStream, {
    headers: {
      "Content-Type": contentType,
    },
  });

  return await response.formData();
}

function parsePhotoUpsertMetadata(
  body: unknown,
  pathPhotoId: string
): PreparedPhotoUpsertMetadata {
  if (!isRecord(body)) {
    throw new Error("Photo metadata must be a JSON object.");
  }

  const allowedKeys = new Set([
    "id",
    "title",
    "date",
    "type",
    "profileId",
    "note",
    "offsetY",
    "offsetXDays",
    "laneIndex",
    "showOnTimeline",
    "seriesId",
    "seriesReminder",
    "social",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported photo field "${key}".`);
    }
  }

  if (typeof body.id !== "string" || !body.id.trim()) {
    throw new Error('Field "id" must be a non-empty string.');
  }
  if (body.id !== pathPhotoId) {
    throw new Error('Photo id in metadata must match the request path.');
  }
  if (typeof body.title !== "string") {
    throw new Error('Field "title" must be a string.');
  }
  if (typeof body.date !== "string" || !isValidDateOnly(body.date)) {
    throw new Error('Field "date" must be in YYYY-MM-DD format.');
  }
  if (body.type !== "personal") {
    throw new Error('Field "type" must be "personal".');
  }

  const title = body.title.trim();
  if (!title) {
    throw new Error('Field "title" cannot be empty.');
  }

  const metadata: PreparedPhotoUpsertMetadata = {
    id: body.id,
    title,
    date: body.date,
    type: "personal",
  };

  if ("profileId" in body && typeof body.profileId !== "string") {
    throw new Error('Field "profileId" must be a string.');
  }
  if (typeof body.profileId === "string" && body.profileId.trim()) {
    metadata.profileId = body.profileId;
  }

  if ("note" in body) {
    if (typeof body.note !== "string") {
      throw new Error('Field "note" must be a string.');
    }
    metadata.note = body.note;
  }

  if ("offsetY" in body) {
    if (typeof body.offsetY !== "number" || !Number.isFinite(body.offsetY)) {
      throw new Error('Field "offsetY" must be a finite number.');
    }
    metadata.offsetY = body.offsetY;
  }

  if ("offsetXDays" in body) {
    if (
      typeof body.offsetXDays !== "number" ||
      !Number.isFinite(body.offsetXDays)
    ) {
      throw new Error('Field "offsetXDays" must be a finite number.');
    }
    metadata.offsetXDays = body.offsetXDays;
  }

  if ("laneIndex" in body) {
    if (
      typeof body.laneIndex !== "number" ||
      !Number.isFinite(body.laneIndex) ||
      body.laneIndex < 0 ||
      !Number.isInteger(body.laneIndex)
    ) {
      throw new Error('Field "laneIndex" must be a non-negative integer.');
    }
    metadata.laneIndex = body.laneIndex;
  }

  if ("showOnTimeline" in body) {
    if (typeof body.showOnTimeline !== "boolean") {
      throw new Error('Field "showOnTimeline" must be a boolean.');
    }
    metadata.showOnTimeline = body.showOnTimeline;
  }

  if ("seriesId" in body) {
    if (typeof body.seriesId !== "string" || !body.seriesId.trim()) {
      throw new Error('Field "seriesId" must be a non-empty string.');
    }
    metadata.seriesId = body.seriesId;
  }

  if ("seriesReminder" in body) {
    if (typeof body.seriesReminder !== "boolean") {
      throw new Error('Field "seriesReminder" must be a boolean.');
    }
    metadata.seriesReminder = body.seriesReminder;
  }

  if ("social" in body) {
    metadata.social = parsePhotoSocialSettings(body.social);
  }

  return metadata;
}

async function readUploadedAsset(
  formData: FormData,
  fieldName: string,
  options: { required: boolean }
): Promise<PreparedUploadedAsset | undefined> {
  const value = formData.get(fieldName);
  if (value == null) {
    if (options.required) {
      throw new Error(`Multipart field "${fieldName}" is required.`);
    }
    return undefined;
  }

  if (!(value instanceof File)) {
    throw new Error(`Multipart field "${fieldName}" must be a file.`);
  }

  if (!value.type || !value.type.startsWith("image/")) {
    throw new Error(`Multipart field "${fieldName}" must be an image upload.`);
  }

  const bytes = Buffer.from(await value.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Multipart field "${fieldName}" cannot be empty.`);
  }

  return {
    bytes,
    fileName: value.name,
    contentType: value.type,
  };
}

async function parsePhotoSaveRequest(
  req: IncomingMessage,
  pathPhotoId: string
): Promise<{
  metadata: PreparedPhotoUpsertMetadata;
  image: PreparedUploadedAsset;
  preview?: PreparedUploadedAsset;
}> {
  const formData = await readMultipartFormData(req);
  const rawMetadata = formData.get("metadata");
  if (typeof rawMetadata !== "string") {
    throw new Error('Multipart field "metadata" must be a JSON string.');
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(rawMetadata);
  } catch {
    throw new Error('Multipart field "metadata" contains invalid JSON.');
  }

  const metadata = parsePhotoUpsertMetadata(parsedMetadata, pathPhotoId);
  const image = await readUploadedAsset(formData, "image", { required: true });
  if (!image) {
    throw new Error('Multipart field "image" is required.');
  }
  const preview = await readUploadedAsset(formData, "preview", {
    required: false,
  });

  return {
    metadata,
    image,
    preview,
  };
}

async function parsePhotoImageUpdateRequest(
  req: IncomingMessage
): Promise<{
  image: PreparedUploadedAsset;
  preview?: PreparedUploadedAsset;
}> {
  const formData = await readMultipartFormData(req);
  const image = await readUploadedAsset(formData, "image", { required: true });
  if (!image) {
    throw new Error('Multipart field "image" is required.');
  }
  const preview = await readUploadedAsset(formData, "preview", {
    required: false,
  });

  return {
    image,
    preview,
  };
}

async function serveAsset(
  res: ServerResponse,
  dataDir: string,
  kind: PersonalAssetKind,
  requestedFileName: string
): Promise<void> {
  const filePath = resolveAssetFilePath(dataDir, kind, requestedFileName);
  if (!filePath) {
    sendText(res, 400, "Invalid asset path.");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    applyCors(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", getMimeType(filePath));
    res.setHeader("Content-Length", fileStat.size);
    res.setHeader("Cache-Control", "public, max-age=3600");
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Asset not found.");
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: PersonalReadonlyServerConfig
): Promise<void> {
  if (req.method === "OPTIONS") {
    applyCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  const authUser = await getAuthenticatedUserFromRequest(req);

  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || `${config.host}:${config.port}`}`
  );
  const pathname = requestUrl.pathname;

  if (isWriteMethod(req.method)) {
    console.log(
      `[auth-debug] write ${req.method} ${pathname} auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"}`
    );
  }

  if (isWriteMethod(req.method)) {
    const granted = authUser !== null;
    console.log(
      `[auth-debug] global-write-gate method=${req.method} pathname=${pathname} auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Missing or invalid personal write token.");
      return;
    }
  }

  if (req.method === "POST" && pathname === "/api/register") {
    try {
      const input = parseRegisterUserInput(await readJsonBody(req));
      const result = await registerUser(input);
      sendJson(res, 201, result);
      return;
    } catch (error) {
      if (error instanceof RegistrationError) {
        const statusCode = error.code === "conflict" ? 409 : 400;
        sendJson(res, statusCode, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }

  if (req.method === "POST" && pathname === "/api/recover-access/request-code") {
    try {
      const input = parseRequestRecoveryCodeInput(await readJsonBody(req));
      const result = await requestRecoveryCode(input);
      sendJson(res, 200, result);
      return;
    } catch (error) {
      if (error instanceof RecoveryError) {
        const statusCode =
          error.code === "not-found" || error.code === "profile-missing"
            ? 404
            : error.code === "email-delivery-failed"
              ? 503
              : 400;
        sendJson(res, statusCode, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }

  if (req.method === "POST" && pathname === "/api/recover-access/verify-code") {
    try {
      const input = parseVerifyRecoveryCodeInput(await readJsonBody(req));
      const result = await verifyRecoveryCode(input);
      sendJson(res, 200, result);
      return;
    } catch (error) {
      if (error instanceof RecoveryError) {
        const statusCode =
          error.code === "not-found" || error.code === "profile-missing"
            ? 404
            : 400;
        sendJson(res, statusCode, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }

  if (req.method === "POST" && pathname === "/api/auth/google") {
    try {
      const input = parseGoogleAuthInput(await readJsonBody(req));
      const result = await authenticateWithGoogle(input);
      sendJson(res, 200, result);
      return;
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        const statusCode =
          error.code === "server-misconfigured"
            ? 503
            : error.code === "conflict"
              ? 409
              : error.code === "profile-missing"
                ? 404
                : error.code === "invalid-token"
                  ? 401
                  : 400;
        sendJson(res, statusCode, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const response: CurrentAuthenticatedUserResult = {
      user: authUser,
    };
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/profiles") {
    const granted = mayUserAdmin(authUser);
    console.log(
      `[auth-debug] GET /api/admin/profiles authPresent=${authUser != null} auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Admin access required.");
      return;
    }

    sendJson(res, 200, {
      profiles: await listProfilesForAdmin(),
    });
    return;
  }

  const photoViewMatch = pathname.match(/^\/api\/photo-views\/photos\/([^/]+)$/);
  if (photoViewMatch) {
    const photoId = decodeURIComponent(photoViewMatch[1]).trim();
    if (!photoId) {
      sendJson(res, 400, {
        error: "invalid-input",
        message: "Photo id is required.",
      });
      return;
    }

    if (req.method === "GET") {
      if (!mayUserAdmin(authUser)) {
        sendText(res, 403, "Admin access required.");
        return;
      }

      sendJson(res, 200, {
        photoId,
        stats: await readPhotoViewStats(photoId),
      });
      return;
    }

    if (req.method !== "POST") {
      sendText(res, 405, "Method not allowed.");
      return;
    }

    try {
      const identity = parsePhotoViewIdentity(await readJsonBody(req), authUser);
      const result = await recordPhotoView(photoId, identity);
      sendJson(res, 200, {
        ok: true,
        photoId,
        countedUnique: result.countedUnique,
        stats: {
          uniqueAccountViews: result.uniqueAccountViews,
          uniqueGuestViews: result.uniqueGuestViews,
          uniqueViews: result.uniqueViews,
          rawOpens: result.rawOpens,
        },
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, {
        error: "invalid-input",
        message,
      });
      return;
    }
  }

  const socialPhotoReactionsMatch = pathname.match(
    /^\/api\/social\/photos\/([^/]+)\/reactions$/
  );
  if (socialPhotoReactionsMatch) {
    const photoId = decodeURIComponent(socialPhotoReactionsMatch[1]).trim();
    if (!photoId) {
      sendJson(res, 400, {
        error: "invalid-input",
        message: "Photo id is required.",
      });
      return;
    }
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed.");
      return;
    }

    const lookup = await findPreparedPhotoForSocial(photoId);
    if (!lookup) {
      sendText(res, 404, "Photo not found.");
      return;
    }

    sendJson(
      res,
      200,
      await buildSocialPhotoReactionResponse(lookup.photo, authUser)
    );
    return;
  }

  const closeReactionMatch = pathname.match(
    /^\/api\/social\/photos\/([^/]+)\/reactions\/close$/
  );
  if (closeReactionMatch) {
    const photoId = decodeURIComponent(closeReactionMatch[1]).trim();
    if (!photoId) {
      sendJson(res, 400, {
        error: "invalid-input",
        message: "Photo id is required.",
      });
      return;
    }
    if (req.method !== "PUT" && req.method !== "DELETE") {
      sendText(res, 405, "Method not allowed.");
      return;
    }
    if (!authUser) {
      sendText(res, 403, "Sign in is required to react.");
      return;
    }

    const lookup = await findPreparedPhotoForSocial(photoId);
    if (!lookup) {
      sendText(res, 404, "Photo not found.");
      return;
    }
    if (!areCloseReactionsAllowed(lookup.photo)) {
      sendJson(res, 409, {
        error: "reactions-disabled",
        message: "Reactions are not enabled for this photo.",
      });
      return;
    }

    if (req.method === "PUT") {
      await putClosePhotoReaction({
        profileId: lookup.photo.profileId,
        photoId: lookup.photo.id,
        userId: authUser.id,
      });
    } else {
      await deleteClosePhotoReaction({
        photoId: lookup.photo.id,
        userId: authUser.id,
      });
    }

    sendJson(
      res,
      200,
      await buildSocialPhotoReactionResponse(lookup.photo, authUser)
    );
    return;
  }

  const photosByDateMatch = pathname.match(/^\/api\/personal\/photos\/by-date\/([^/]+)$/);
  if (req.method === "DELETE" && photosByDateMatch) {
    const date = decodeURIComponent(photosByDateMatch[1]);
    if (!isValidDateOnly(date)) {
      sendText(res, 400, "Date must be in YYYY-MM-DD format.");
      return;
    }

    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const requestDataDir = requestProfile
      ? readWriteDatasetDirForProfile(requestProfile)
      : personalPreparedDatasetDir();
    const profileIdsInDay = await readPreparedPhotoProfileIdsInDay(
      requestDataDir,
      date
    );
    const targetedProfileIds = [...new Set(profileIdsInDay)];
    const isAdmin = mayUserAdmin(authUser);
    let targetProfile: ProfileModel | null = null;
    let granted = false;

    if (isAdmin) {
      granted = true;
    } else if (targetedProfileIds.length === 0) {
      granted = authUser !== null;
    } else if (targetedProfileIds.length === 1) {
      targetProfile = await resolveProfileByAnyProfileId(targetedProfileIds[0]);
      granted = mayUserWriteProfile(authUser, targetProfile);
    }

    console.log(
      `[auth-debug] route=delete-photos-by-date auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileIds=${JSON.stringify(targetedProfileIds)} granted=${granted}`
    );

    if (!granted) {
      sendText(
        res,
        403,
        targetedProfileIds.length > 1
          ? "Deleting photos across multiple profiles is not allowed."
          : "Write access is limited to the current user's profile."
      );
      return;
    }

    const deletedPhotoIds = await deletePreparedPhotosInDay(requestDataDir, date);
    sendJson(res, 200, { deletedPhotoIds });
    return;
  }

  const photoImportMatch = pathname.match(
    /^\/api\/personal\/photos\/([^/]+)\/import$/
  );
  if (req.method === "POST" && photoImportMatch) {
    const sourcePhotoId = decodeURIComponent(photoImportMatch[1]).trim();
    if (!sourcePhotoId) {
      sendJson(res, 400, {
        error: "invalid-input",
        message: "Photo id is required.",
      });
      return;
    }
    if (!authUser) {
      sendText(res, 403, "Sign in is required to import a photo.");
      return;
    }

    let importRequest: ImportPhotoRequest;
    try {
      importRequest = parseImportPhotoRequest(await readJsonBody(req));
    } catch (error) {
      sendJson(res, 400, {
        error: "invalid-input",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const targetProfile = await getAuthenticatedPrimaryProfile(authUser);
    if (!targetProfile) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }

    const sourceLookup = await findVisibleSourcePhotoProfile(sourcePhotoId);
    if (!sourceLookup) {
      sendText(res, 404, "Photo not found.");
      return;
    }

    const targetDataDir = readWriteDatasetDirForProfile(targetProfile);
    await ensurePreparedPersonalDataset(targetDataDir);
    const result = await importPreparedPhotos(targetDataDir, {
      sourceDataDir: sourceLookup.dataDir,
      sourcePhotoId,
      sourceProfileId: getProfileDatasetProfileId(sourceLookup.profile),
      sourceProfileSlug: sourceLookup.profile.slug,
      sourceAuthorName: await getSourceAuthorName(sourceLookup.profile),
      targetProfileId: getProfileDatasetProfileId(targetProfile),
      includeText: importRequest.includeText,
      includeAllPhotosOfDay: importRequest.includeAllPhotosOfDay,
    });

    const dataset = await readPreparedPersonalDataset(
      targetDataDir,
      profileAssetBasePath(targetProfile)
    );
    const byId = new Map(
      dataset.photosResponse.photos.map((photo) => [photo.id, photo])
    );
    sendJson(res, 200, {
      created: result.createdPhotoIds.map((id) => byId.get(id)).filter(Boolean),
      skipped: result.skippedPhotoIds.map((id) => byId.get(id)).filter(Boolean),
    });
    return;
  }

  const photoSaveMatch = pathname.match(/^\/api\/personal\/photos\/([^/]+)$/);
  if (req.method === "PUT" && photoSaveMatch) {
    const photoId = decodeURIComponent(photoSaveMatch[1]);
    const payload = await parsePhotoSaveRequest(req, photoId);
    if (!payload.metadata.profileId && authUser?.primaryProfileId) {
      payload.metadata.profileId = authUser.primaryProfileId;
    }
    const targetProfile = await resolveProfileByAnyProfileId(
      payload.metadata.profileId
    );
    const granted = mayUserWriteProfile(authUser, targetProfile);
    console.log(
      `[auth-debug] route=upsert-photo auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileId=${targetProfile?.id ?? payload.metadata.profileId ?? "n/a"} granted=${granted}`
    );
    if (!targetProfile || !granted) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }
    const targetDataDir = readWriteDatasetDirForProfile(targetProfile);
    await ensurePreparedPersonalDataset(targetDataDir);
    await savePreparedPhoto(targetDataDir, payload);

    const dataset = await readPreparedPersonalDataset(
      targetDataDir,
      profileAssetBasePath(targetProfile)
    );
    const photo = dataset.photosResponse.photos.find((item) => item.id === photoId);
    if (!photo) {
      sendText(res, 500, "Saved photo is missing from dataset.");
      return;
    }

    sendJson(res, 200, { photo });
    return;
  }

  const photoDeleteMatch = pathname.match(/^\/api\/personal\/photos\/([^/]+)$/);
  if (req.method === "DELETE" && photoDeleteMatch) {
    const photoId = decodeURIComponent(photoDeleteMatch[1]);
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const requestDataDir = requestProfile
      ? readWriteDatasetDirForProfile(requestProfile)
      : personalPreparedDatasetDir();
    const targetProfileId = await readPreparedPhotoProfileId(
      requestDataDir,
      photoId
    );
    const targetProfile = await resolveProfileByAnyProfileId(targetProfileId);
    const granted = mayUserWriteProfile(authUser, targetProfile);
    console.log(
      `[auth-debug] route=delete-photo auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileId=${targetProfile?.id ?? targetProfileId ?? "n/a"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }
    const deleted = await deletePreparedPhoto(requestDataDir, photoId);
    if (!deleted) {
      sendText(res, 404, "Photo not found.");
      return;
    }

    sendJson(res, 200, { ok: true, photoId });
    return;
  }

  const photoImageMatch = pathname.match(/^\/api\/personal\/photos\/([^/]+)\/image$/);
  if (req.method === "PUT" && photoImageMatch) {
    const photoId = decodeURIComponent(photoImageMatch[1]);
    const payload = await parsePhotoImageUpdateRequest(req);
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const requestDataDir = requestProfile
      ? readWriteDatasetDirForProfile(requestProfile)
      : personalPreparedDatasetDir();
    const targetProfileId = await readPreparedPhotoProfileId(
      requestDataDir,
      photoId
    );
    const targetProfile = await resolveProfileByAnyProfileId(targetProfileId);
    const granted = mayUserWriteProfile(authUser, targetProfile);
    console.log(
      `[auth-debug] route=replace-photo-image auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileId=${targetProfile?.id ?? targetProfileId ?? "n/a"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }
    const updated = await replacePreparedPhotoImage(requestDataDir, photoId, payload);
    if (!updated) {
      sendText(res, 404, "Photo not found.");
      return;
    }

    const dataset = await readPreparedPersonalDataset(
      requestDataDir,
      targetProfile ? profileAssetBasePath(targetProfile) : personalAssetBasePath()
    );
    const photo = dataset.photosResponse.photos.find((item) => item.id === photoId);
    if (!photo) {
      sendText(res, 500, "Updated photo is missing from dataset.");
      return;
    }

    sendJson(res, 200, { photo });
    return;
  }

  const metadataMatch = pathname.match(
    /^\/api\/personal\/photos\/([^/]+)\/metadata$/
  );
  if (req.method === "PATCH" && metadataMatch) {
    const photoId = decodeURIComponent(metadataMatch[1]);
    const patch = parsePhotoMetadataPatch(await readJsonBody(req));
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const requestDataDir = requestProfile
      ? readWriteDatasetDirForProfile(requestProfile)
      : personalPreparedDatasetDir();
    const targetProfileId = await readPreparedPhotoProfileId(
      requestDataDir,
      photoId
    );
    const targetProfile = await resolveProfileByAnyProfileId(targetProfileId);
    const granted = mayUserWriteProfile(authUser, targetProfile);
    console.log(
      `[auth-debug] route=patch-photo-metadata auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileId=${targetProfile?.id ?? targetProfileId ?? "n/a"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }
    const updated = await updatePreparedPhotoMetadata(requestDataDir, photoId, patch);
    if (!updated) {
      sendText(res, 404, "Photo not found.");
      return;
    }

    const dataset = await readPreparedPersonalDataset(
      requestDataDir,
      targetProfile ? profileAssetBasePath(targetProfile) : personalAssetBasePath()
    );
    const photo = dataset.photosResponse.photos.find((item) => item.id === photoId);
    if (!photo) {
      sendText(res, 500, "Updated photo is missing from dataset.");
      return;
    }

    sendJson(res, 200, { photo });
    return;
  }

  const photoSeriesMatch = pathname.match(
    /^\/api\/personal\/photos\/([^/]+)\/series$/
  );
  if (req.method === "PATCH" && photoSeriesMatch) {
    const photoId = decodeURIComponent(photoSeriesMatch[1]);
    const patch = parsePhotoSeriesPatch(await readJsonBody(req));
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const requestDataDir = requestProfile
      ? readWriteDatasetDirForProfile(requestProfile)
      : personalPreparedDatasetDir();
    const targetProfileId = await readPreparedPhotoProfileId(
      requestDataDir,
      photoId
    );
    const targetProfile = await resolveProfileByAnyProfileId(targetProfileId);
    const granted = mayUserWriteProfile(authUser, targetProfile);
    console.log(
      `[auth-debug] route=patch-photo-series auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileId=${targetProfile?.id ?? targetProfileId ?? "n/a"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }
    const result = await updatePreparedPhotoSeries(requestDataDir, photoId, patch);

    if (result === "photo-not-found") {
      sendText(res, 404, "Photo not found.");
      return;
    }
    if (result === "series-not-found") {
      sendText(res, 400, "Series not found.");
      return;
    }

    const dataset = await readPreparedPersonalDataset(
      requestDataDir,
      targetProfile ? profileAssetBasePath(targetProfile) : personalAssetBasePath()
    );
    const photo = dataset.photosResponse.photos.find((item) => item.id === photoId);
    if (!photo) {
      sendText(res, 500, "Updated photo is missing from dataset.");
      return;
    }

    sendJson(res, 200, { photo });
    return;
  }

  const seriesMatch = pathname.match(/^\/api\/personal\/series\/([^/]+)$/);
  if (req.method === "PUT" && seriesMatch) {
    const seriesId = decodeURIComponent(seriesMatch[1]);
    const series = parseSeriesRecord(await readJsonBody(req), seriesId);
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const requestDataDir = requestProfile
      ? readWriteDatasetDirForProfile(requestProfile)
      : personalPreparedDatasetDir();
    const existingSeries = await readPreparedSeries(
      requestDataDir,
      seriesId
    );
    const targetProfileId =
      series.profileId ?? existingSeries?.profileId ?? authUser?.primaryProfileId;
    const targetProfile = await resolveProfileByAnyProfileId(targetProfileId);
    const granted = mayUserWriteProfile(authUser, targetProfile);
    console.log(
      `[auth-debug] route=upsert-series auth=${authUser ? `${authUser.id}/${authUser.role}` : "null"} targetProfileId=${targetProfile?.id ?? targetProfileId ?? "n/a"} granted=${granted}`
    );
    if (!granted) {
      sendText(res, 403, "Write access is limited to the current user's profile.");
      return;
    }
    const nextSeries = {
      ...series,
      profileId: targetProfile?.id ?? targetProfileId ?? "",
    };
    const targetDataDir = targetProfile
      ? readWriteDatasetDirForProfile(targetProfile)
      : requestDataDir;
    await ensurePreparedPersonalDataset(targetDataDir);
    await savePreparedSeries(targetDataDir, nextSeries);
    sendJson(res, 200, { series: nextSeries });
    return;
  }

const profileMatch = pathname.match(/^\/api\/profile\/([^/]+)$/);
if (req.method === "GET" && profileMatch) {
  const slug = decodeURIComponent(profileMatch[1]);
  const profile = await getProfileBySlug(slug);

  if (!profile) {
    sendJson(res, 404, { error: "Profile not found" });
    return;
  }

  sendJson(res, 200, profile);
  return;
}

const profilePhotosMatch = pathname.match(/^\/api\/profile\/([^/]+)\/photos$/);
if (req.method === "GET" && profilePhotosMatch) {
  const slug = decodeURIComponent(profilePhotosMatch[1]);
  const profile = await getProfileBySlug(slug);

  if (!profile) {
    sendJson(res, 404, { error: "Profile not found" });
    return;
  }

  const dataset = await readPreparedPersonalDataset(
    profileDatasetDir(profile),
    profileAssetBasePath(profile)
  );
  const photos = dataset.photosResponse.photos.filter(
    (photo) => photo.profileId === profile.personalDataset.profileId
  );

  sendJson(res, 200, { photos });
  return;
}


  if (req.method !== "GET") {
    sendText(res, 405, "Method not allowed.");
    return;
  }

  if (pathname === "/api/personal/photos") {
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const dataset = await readPreparedPersonalDataset(
      requestProfile ? profileDatasetDir(requestProfile) : personalPreparedDatasetDir(),
      requestProfile ? profileAssetBasePath(requestProfile) : personalAssetBasePath()
    );
    sendJson(res, 200, dataset.photosResponse);
    return;
  }

  const personalPhotoReadMatch = pathname.match(
    /^\/api\/personal\/photos\/([^/]+)$/
  );
  if (personalPhotoReadMatch) {
    const photoId = decodeURIComponent(personalPhotoReadMatch[1]);
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const dataset = await readPreparedPersonalDataset(
      requestProfile ? profileDatasetDir(requestProfile) : personalPreparedDatasetDir(),
      requestProfile ? profileAssetBasePath(requestProfile) : personalAssetBasePath()
    );
    const photo = dataset.photosResponse.photos.find((item) => item.id === photoId);
    if (!photo) {
      sendText(res, 404, "Photo not found.");
      return;
    }

    sendJson(res, 200, { photo });
    return;
  }

  if (pathname === "/api/personal/series") {
    const requestProfile = await getAuthenticatedPrimaryProfile(authUser);
    const dataset = await readPreparedPersonalDataset(
      requestProfile ? profileDatasetDir(requestProfile) : personalPreparedDatasetDir(),
      requestProfile ? profileAssetBasePath(requestProfile) : personalAssetBasePath()
    );
    sendJson(res, 200, dataset.seriesResponse);
    return;
  }

  const scopedAssetMatch = pathname.match(
    /^\/api\/personal\/assets\/([^/]+)\/(images|previews)\/([^/]+)$/
  );
  if (scopedAssetMatch) {
    const [, dirName, kind, requestedFileName] = scopedAssetMatch;
    await serveAsset(
      res,
      personalPreparedDatasetDir({ dirName: decodeURIComponent(dirName) }),
      kind as PersonalAssetKind,
      requestedFileName
    );
    return;
  }

  const imagePrefix = "/api/personal/assets/images/";
  if (pathname.startsWith(imagePrefix)) {
    await serveAsset(
      res,
      personalPreparedDatasetDir(),
      "images",
      pathname.slice(imagePrefix.length)
    );
    return;
  }

  const previewPrefix = "/api/personal/assets/previews/";
  if (pathname.startsWith(previewPrefix)) {
    await serveAsset(
      res,
      personalPreparedDatasetDir(),
      "previews",
      pathname.slice(previewPrefix.length)
    );
    return;
  }

  sendText(res, 404, "Not found.");
}

async function main(): Promise<void> {
  const config = getConfig();
  const identityStore = await ensureIdentityStore();
  await ensurePreparedPersonalDataset(personalPreparedDatasetDir());

  const server = createServer((req, res) => {
    handleRequest(req, res, config).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendText(res, 500, message);
    });
  });

  server.listen(config.port, config.host, () => {
    const publicBaseUrl =
      config.publicBaseUrl || `http://${config.host}:${config.port}`;
    console.log(`[personal-backend] data dir: ${personalPreparedDatasetDir()}`);
    console.log(
      `[personal-backend] identity store: ${identityStore.storePath} (source=${identityStore.source}, init=${identityStore.initialization})`
    );
    console.log(`[personal-backend] photos: ${publicBaseUrl}/api/personal/photos`);
    console.log(`[personal-backend] series: ${publicBaseUrl}/api/personal/series`);
    console.log(
      "[personal-backend] mutating routes require X-Personal-Write-Token with a registered user token."
    );
  });
}

main().catch((error) => {
  console.error("[personal-backend] startup failed", error);
  process.exitCode = 1;
});
