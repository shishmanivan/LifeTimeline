import fs from "fs";
import path from "path";

export const IMAGE_EXTENSIONS = [
  ".webp",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".png",
  ".avif",
  ".svg",
] as const;

const JPEG_ALIASES = new Set([".jpg", ".jpeg", ".jfif"]);

export function normalizeImageExtension(ext: string | undefined): string | undefined {
  if (!ext) return undefined;
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  if (JPEG_ALIASES.has(normalized)) return ".jpg";
  return IMAGE_EXTENSIONS.includes(normalized as (typeof IMAGE_EXTENSIONS)[number])
    ? normalized
    : undefined;
}

export function getExtensionFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    for (const ext of IMAGE_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        return normalizeImageExtension(ext);
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function detectImageExtensionFromContent(
  buffer: Uint8Array,
  contentType?: string | null,
  currentExt?: string
): string | undefined {
  const byContentType = normalizeContentTypeToExtension(contentType, currentExt);
  if (byContentType) return byContentType;

  const byBytes = detectImageExtensionFromBytes(buffer, currentExt);
  if (byBytes) return byBytes;

  return normalizeImageExtension(currentExt);
}

export async function fetchImageAsset(imageUrl: string): Promise<{
  buffer: Buffer;
  extension: string;
}> {
  const res = await fetch(imageUrl, { mode: "cors" });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${imageUrl}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const extension = detectImageExtensionFromContent(
    buffer,
    res.headers.get("content-type"),
    getExtensionFromUrl(imageUrl)
  );

  if (!extension) {
    throw new Error(
      `Could not detect image extension for ${imageUrl} (content-type: ${res.headers.get("content-type") ?? "none"})`
    );
  }

  return { buffer, extension };
}

export function detectFileExtension(filePath: string): string | undefined {
  const buffer = fs.readFileSync(filePath);
  return detectImageExtensionFromContent(buffer, undefined, path.extname(filePath));
}

export function findBestExistingFileByDate(dirPath: string, date: string): string | undefined {
  if (!fs.existsSync(dirPath)) return undefined;

  const candidates = fs
    .readdirSync(dirPath)
    .filter((file) => file !== "_manifest.json" && file.startsWith(`${date}.`))
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) return undefined;
  return `${date}.jpg`;
}

function normalizeContentTypeToExtension(
  contentType: string | null | undefined,
  currentExt?: string
): string | undefined {
  const raw = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!raw) return undefined;

  if (raw === "image/webp") return ".webp";
  if (raw === "image/png") return ".png";
  if (raw === "image/svg+xml") return ".svg";
  if (raw === "image/avif") return ".avif";
  if (raw === "image/jpeg" || raw === "image/jpg" || raw === "image/pjpeg") {
    const current = normalizeImageExtension(currentExt);
    return current && JPEG_ALIASES.has(current) ? current : ".jpg";
  }

  return undefined;
}

function detectImageExtensionFromBytes(
  buffer: Uint8Array,
  currentExt?: string
): string | undefined {
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return ".webp";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const current = normalizeImageExtension(currentExt);
    return current && JPEG_ALIASES.has(current) ? current : ".jpg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return ".png";
  }

  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const brand = Buffer.from(buffer.slice(8, 12)).toString("ascii").toLowerCase();
    if (brand === "avif" || brand === "avis") return ".avif";
  }

  const text = Buffer.from(buffer.slice(0, Math.min(buffer.length, 512))).toString("utf8").trimStart();
  if (text.startsWith("<svg") || text.startsWith("<?xml")) {
    return ".svg";
  }

  return undefined;
}
