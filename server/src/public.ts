import type { Database } from "bun:sqlite";

import { loadPublicSettings, resolvePublicDefaults } from "./admin-settings";
import { listChannels, publicChannels, resolveDefaultModels } from "./channels";
import type { ServerConfig } from "./config";
import type { Router } from "./http";
import { HttpError, isSecureRequest, jsonResponse, readJsonBody, serializeCookie } from "./http";
import { CLIENT_COOKIE, CLIENT_COOKIE_MAX_AGE, clientCookieValue, getClientFromRequest, registerClient } from "./identity";
import { quotaStatusFor } from "./quota";
import type { QuotaPolicy } from "./types";

export type PublicDeps = {
    db: Database;
    config: ServerConfig;
    getQuotaPolicy: () => QuotaPolicy;
    hasAdminSession: (req: Request) => boolean;
};

export function registerPublicRoutes(router: Router, deps: PublicDeps) {
    router.get("/api/health", () =>
        jsonResponse({
            ok: true,
            version: deps.config.version,
            uptimeSeconds: Math.round(process.uptime()),
        }),
    );

    router.get("/api/bootstrap", (req) => {
        const channels = listChannels(deps.db, deps.config.secret);
        const policy = deps.getQuotaPolicy();
        const client = getClientFromRequest(deps.db, deps.config.secret, req.headers.get("cookie"));
        return jsonResponse({
            serverMode: true,
            version: deps.config.version,
            channels: publicChannels(channels),
            defaultModels: resolveDefaultModels(deps.db, channels),
            quotaPolicy: resolvePublicDefaults(policy),
            quota: client ? quotaStatusFor(deps.db, policy, client, undefined, deps.hasAdminSession(req)) : null,
            publicSettings: loadPublicSettings(deps.db),
            admin: deps.hasAdminSession(req),
        });
    });

    router.post("/api/session/fingerprint", async (req, ctx) => {
        const body = await readJsonBody<{ visitorId?: unknown; source?: unknown; ua?: unknown; lang?: unknown; timezone?: unknown }>(req, 16 * 1024);
        const client = registerClient(deps.db, deps.config.secret, req.headers.get("cookie"), ctx.ip, {
            fingerprint: body.visitorId,
            source: body.source,
            userAgent: body.ua || req.headers.get("user-agent"),
        });
        const policy = deps.getQuotaPolicy();
        const cookie = serializeCookie(CLIENT_COOKIE, clientCookieValue(deps.config.secret, client.id), {
            maxAgeSeconds: CLIENT_COOKIE_MAX_AGE,
            httpOnly: true,
            sameSite: "Lax",
            secure: isSecureRequest(req),
        });
        return jsonResponse(
            {
                clientId: client.id,
                blocked: client.blocked,
                quota: quotaStatusFor(deps.db, policy, client, undefined, deps.hasAdminSession(req)),
                publicSettings: loadPublicSettings(deps.db),
            },
            200,
            { "set-cookie": cookie },
        );
    });

    router.get("/api/quota", (req) => {
        const client = getClientFromRequest(deps.db, deps.config.secret, req.headers.get("cookie"));
        if (!client) throw new HttpError(401, "session_required", "会话已失效，请刷新页面");
        const policy = deps.getQuotaPolicy();
        return jsonResponse({ quota: quotaStatusFor(deps.db, policy, client, undefined, deps.hasAdminSession(req)), blocked: client.blocked });
    });
}

export function fingerprintCookieForRequest(config: ServerConfig, req: Request, clientId: string): string {
    return serializeCookie(CLIENT_COOKIE, clientCookieValue(config.secret, clientId), {
        maxAgeSeconds: CLIENT_COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: "Lax",
        secure: isSecureRequest(req),
    });
}
