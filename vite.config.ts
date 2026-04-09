import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PICS_ROOT = path.resolve(__dirname, "src/history/HistoryPics");

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
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
    case ".svg":
      return "image/svg+xml";
    case ".jfif":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function historyPicsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void {
  const raw = (req.url ?? "").split("?")[0] ?? "";
  if (!raw.startsWith("/history-pics/")) {
    next();
    return;
  }

  let rel: string;
  try {
    rel = decodeURIComponent(raw.slice("/history-pics/".length));
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) {
    res.statusCode = 400;
    res.end();
    return;
  }

  const fsPath = path.resolve(HISTORY_PICS_ROOT, ...rel.split("/"));
  if (!isPathInsideRoot(HISTORY_PICS_ROOT, fsPath)) {
    res.statusCode = 400;
    res.end();
    return;
  }

  fs.stat(fsPath, (err, st) => {
    if (err || !st.isFile()) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeForExt(path.extname(fsPath)));
    res.setHeader("Content-Length", String(st.size));
    const stream = fs.createReadStream(fsPath);
    stream.on("error", () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
  });
}

/** Image bytes copied into dist for `vite preview` and static hosts (dev uses middleware below). */
const HISTORY_PIC_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".avif",
  ".svg",
  ".jfif",
]);

async function copyHistoryImageTree(srcDir: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = path.join(srcDir, e.name);
    const dest = path.join(destDir, e.name);
    if (e.isDirectory()) {
      await copyHistoryImageTree(src, dest);
    } else if (e.isFile() && HISTORY_PIC_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      await fsp.copyFile(src, dest);
    }
  }
}

async function copyHistoryPicsIntoOutDir(outDir: string): Promise<void> {
  try {
    await fsp.access(HISTORY_PICS_ROOT);
  } catch {
    return;
  }
  const destRoot = path.join(outDir, "history-pics");
  await copyHistoryImageTree(HISTORY_PICS_ROOT, destRoot);
}

function serveHistoryPicsDevPlugin(): Plugin {
  return {
    name: "serve-history-pics-dev",
    configureServer(server) {
      server.middlewares.use(historyPicsMiddleware);
    },
  };
}

function copyHistoryPicsToDistPlugin(): Plugin {
  let resolved: ResolvedConfig;
  return {
    name: "copy-history-pics-to-dist",
    apply: "build",
    configResolved(config) {
      resolved = config;
    },
    async closeBundle() {
      const outDir = path.resolve(resolved.root, resolved.build.outDir);
      await copyHistoryPicsIntoOutDir(outDir);
    },
  };
}

export default defineConfig({
  plugins: [react(), serveHistoryPicsDevPlugin(), copyHistoryPicsToDistPlugin()],
  assetsInclude: ["**/*.jfif", "**/*.tsv", "**/*.JPG"],
});
