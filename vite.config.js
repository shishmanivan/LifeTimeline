var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var HISTORY_PICS_ROOT = path.resolve(__dirname, "src/history/HistoryPics");
function mimeForExt(ext) {
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
function isPathInsideRoot(root, candidate) {
    var rel = path.relative(root, candidate);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function historyPicsMiddleware(req, res, next) {
    var _a, _b;
    var raw = (_b = ((_a = req.url) !== null && _a !== void 0 ? _a : "").split("?")[0]) !== null && _b !== void 0 ? _b : "";
    if (!raw.startsWith("/history-pics/")) {
        next();
        return;
    }
    var rel;
    try {
        rel = decodeURIComponent(raw.slice("/history-pics/".length));
    }
    catch (_c) {
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
    var fsPath = path.resolve.apply(path, __spreadArray([HISTORY_PICS_ROOT], rel.split("/"), false));
    if (!isPathInsideRoot(HISTORY_PICS_ROOT, fsPath)) {
        res.statusCode = 400;
        res.end();
        return;
    }
    fs.stat(fsPath, function (err, st) {
        if (err || !st.isFile()) {
            next();
            return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", mimeForExt(path.extname(fsPath)));
        res.setHeader("Content-Length", String(st.size));
        var stream = fs.createReadStream(fsPath);
        stream.on("error", function () {
            if (!res.headersSent)
                res.statusCode = 500;
            res.end();
        });
        stream.pipe(res);
    });
}
/** Image bytes copied into dist for `vite preview` and static hosts (dev uses middleware below). */
var HISTORY_PIC_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".avif",
    ".svg",
    ".jfif",
]);
function copyHistoryImageTree(srcDir, destDir) {
    return __awaiter(this, void 0, void 0, function () {
        var entries, _i, entries_1, e, src, dest;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fsp.mkdir(destDir, { recursive: true })];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, fsp.readdir(srcDir, { withFileTypes: true })];
                case 2:
                    entries = _a.sent();
                    _i = 0, entries_1 = entries;
                    _a.label = 3;
                case 3:
                    if (!(_i < entries_1.length)) return [3 /*break*/, 8];
                    e = entries_1[_i];
                    src = path.join(srcDir, e.name);
                    dest = path.join(destDir, e.name);
                    if (!e.isDirectory()) return [3 /*break*/, 5];
                    return [4 /*yield*/, copyHistoryImageTree(src, dest)];
                case 4:
                    _a.sent();
                    return [3 /*break*/, 7];
                case 5:
                    if (!(e.isFile() && HISTORY_PIC_EXTENSIONS.has(path.extname(e.name).toLowerCase()))) return [3 /*break*/, 7];
                    return [4 /*yield*/, fsp.copyFile(src, dest)];
                case 6:
                    _a.sent();
                    _a.label = 7;
                case 7:
                    _i++;
                    return [3 /*break*/, 3];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function copyHistoryPicsIntoOutDir(outDir) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, destRoot;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, fsp.access(HISTORY_PICS_ROOT)];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/];
                case 3:
                    destRoot = path.join(outDir, "history-pics");
                    return [4 /*yield*/, copyHistoryImageTree(HISTORY_PICS_ROOT, destRoot)];
                case 4:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function serveHistoryPicsDevPlugin() {
    return {
        name: "serve-history-pics-dev",
        configureServer: function (server) {
            server.middlewares.use(historyPicsMiddleware);
        },
    };
}
function copyHistoryPicsToDistPlugin() {
    var resolved;
    return {
        name: "copy-history-pics-to-dist",
        apply: "build",
        configResolved: function (config) {
            resolved = config;
        },
        closeBundle: function () {
            return __awaiter(this, void 0, void 0, function () {
                var outDir;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            outDir = path.resolve(resolved.root, resolved.build.outDir);
                            return [4 /*yield*/, copyHistoryPicsIntoOutDir(outDir)];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        },
    };
}
export default defineConfig({
    plugins: [react(), serveHistoryPicsDevPlugin(), copyHistoryPicsToDistPlugin()],
    assetsInclude: ["**/*.jfif", "**/*.tsv", "**/*.JPG"],
});
