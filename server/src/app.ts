import type { Database } from "bun:sqlite";

import { checkAdminSession, registerAdminRoutes } from "./admin";
import type { ServerConfig } from "./config";
import { HttpError, httpErrorToResponse, jsonResponse, Router } from "./http";
import { log } from "./logger";
import { registerPublicRoutes } from "./public";
import { loadQuotaPolicy } from "./quota";
import { createRelayHandler } from "./relay";
import { RateLimiter } from "./security";
import { createStaticHandler } from "./static";
import type { QuotaPolicy } from "./types";

export type App = {
    fetch(req: Request, socketIp?: string): Promise<Response>;
    getQuotaPolicy(): QuotaPolicy;
};

export function createApp(config: ServerConfig, db: Database): App {
    let quotaPolicy = loadQuotaPolicy(db, config.defaultQuota);
    const relayLimiter = new RateLimiter(120, 60_000);

    const router = new Router(config);
    registerPublicRoutes(router, {
        db,
        config,
        getQuotaPolicy: () => quotaPolicy,
        hasAdminSession: (req) => checkAdminSession(db, config.secret, req),
    });
    registerAdminRoutes(router, {
        db,
        config,
        getQuotaPolicy: () => quotaPolicy,
        setQuotaPolicy: (next) => {
            quotaPolicy = next;
        },
    });
    router.any(
        "/api/relay",
        createRelayHandler({ db, config, getQuotaPolicy: () => quotaPolicy, relayLimiter, isAdminRequest: (req) => checkAdminSession(db, config.secret, req) }),
    );

    const staticHandler = createStaticHandler(config);

    return {
        getQuotaPolicy: () => quotaPolicy,
        async fetch(req: Request, socketIp = "127.0.0.1") {
            const url = new URL(req.url);
            try {
                if (url.pathname.startsWith("/api/")) {
                    const response = await router.handle(req, socketIp);
                    if (response) return response;
                    return jsonResponse({ error: { message: "接口不存在" }, code: "not_found" }, 404);
                }
                return await staticHandler(req, url);
            } catch (error) {
                if (error instanceof HttpError) return httpErrorToResponse(error);
                log.error("unhandled request error", {
                    path: url.pathname,
                    message: error instanceof Error ? error.message : String(error),
                });
                return jsonResponse({ error: { message: "服务器内部错误" }, code: "internal_error" }, 500);
            }
        },
    };
}
