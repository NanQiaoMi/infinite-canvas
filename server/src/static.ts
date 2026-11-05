import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { analyticsConfigScript, type ServerConfig } from "./config";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
};

export function createStaticHandler(config: ServerConfig) {
    const distDir = resolve(config.webDistDir);
    const indexPath = join(distDir, "index.html");

    return async (req: Request, url: URL): Promise<Response> => {
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });

        if (url.pathname === "/config.js") {
            return new Response(analyticsConfigScript(config), {
                headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
            });
        }

        let pathname = url.pathname;
        try {
            pathname = decodeURIComponent(url.pathname);
        } catch {
            return new Response("Bad Request", { status: 400 });
        }
        const relative = pathname.replace(/^\/+/, "");
        const candidate = resolve(join(distDir, relative));
        if (candidate !== distDir && !candidate.startsWith(`${distDir}${sep}`)) return new Response("Not Found", { status: 404 });

        if (relative && existsSync(candidate) && statSync(candidate).isFile()) {
            const file = Bun.file(candidate);
            const headers = new Headers();
            headers.set("content-type", CONTENT_TYPES[extname(candidate).toLowerCase()] || file.type || "application/octet-stream");
            headers.set("cache-control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
            return new Response(req.method === "HEAD" ? null : file, { headers });
        }

        if (existsSync(indexPath)) {
            return new Response(req.method === "HEAD" ? null : Bun.file(indexPath), {
                headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
            });
        }

        return new Response("前端产物不存在：请先执行 `cd web && bun run build`。", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
        });
    };
}
