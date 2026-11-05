import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { Capability, CapabilityLimits, QuotaPolicy } from "./types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_TIMEZONE = "Asia/Shanghai";

function intEnv(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function textEnv(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
}

function readVersion(root: string): string {
    try {
        return readFileSync(join(root, "VERSION"), "utf8").trim() || "dev";
    } catch {
        return "dev";
    }
}

function loadOrCreateSecret(dataDir: string): string {
    const secretPath = join(dataDir, "secret.key");
    if (existsSync(secretPath)) {
        const value = readFileSync(secretPath, "utf8").trim();
        if (value) return value;
    }
    const secret = randomBytes(32).toString("hex");
    writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
    return secret;
}

function buildDefaultLimits(env: Record<string, string | undefined>): Record<Capability, CapabilityLimits> {
    return {
        image: {
            daily: intEnv(env.QUOTA_IMAGE_DAILY_LIMIT, 100),
            weekly: intEnv(env.QUOTA_IMAGE_WEEKLY_LIMIT, 700),
            ipDaily: intEnv(env.QUOTA_IMAGE_IP_DAILY_LIMIT, 0),
            ipWeekly: intEnv(env.QUOTA_IMAGE_IP_WEEKLY_LIMIT, 0),
        },
        text: {
            daily: intEnv(env.QUOTA_TEXT_DAILY_LIMIT, 0),
            weekly: intEnv(env.QUOTA_TEXT_WEEKLY_LIMIT, 0),
            ipDaily: 0,
            ipWeekly: 0,
        },
        video: {
            daily: intEnv(env.QUOTA_VIDEO_DAILY_LIMIT, 0),
            weekly: intEnv(env.QUOTA_VIDEO_WEEKLY_LIMIT, 0),
            ipDaily: 0,
            ipWeekly: 0,
        },
        audio: {
            daily: intEnv(env.QUOTA_AUDIO_DAILY_LIMIT, 0),
            weekly: intEnv(env.QUOTA_AUDIO_WEEKLY_LIMIT, 0),
            ipDaily: 0,
            ipWeekly: 0,
        },
    };
}

export function defaultQuotaPolicy(env: Record<string, string | undefined> = process.env): QuotaPolicy {
    return {
        timezone: textEnv(env.QUOTA_TIMEZONE, textEnv(env.TZ, DEFAULT_TIMEZONE)),
        capabilities: buildDefaultLimits(env),
        adminExempt: true,
        refundOnFailure: true,
    };
}

export type ServerConfig = {
    port: number;
    /** 是否运行在 Docker 容器内（用于 localhost → host.docker.internal 改写）。 */
    runningInDocker: boolean;
    dataDir: string;
    dbPath: string;
    schemaPath: string;
    webDistDir: string;
    version: string;
    secret: string;
    adminUsername: string;
    /** 仅首次初始化使用；为空时随机生成并打印一次。 */
    adminPassword: string | null;
    trustProxy: boolean;
    defaultQuota: QuotaPolicy;
    maxBodyBytes: number;
    relayTimeoutMs: number;
    mediaTimeoutMs: number;
    analyticsGa4Id: string;
    analyticsBaiduId: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
    const projectRoot = textEnv(env.APP_ROOT, REPO_ROOT);
    const dataDir = resolve(env.DATA_DIR || join(projectRoot, "data"));
    mkdirSync(dataDir, { recursive: true });
    const schemaPath = join(import.meta.dir, "schema.sql");
    const webDistDir = resolve(env.WEB_DIST_DIR || join(projectRoot, "web", "dist"));
    const runningInDocker = existsSync("/.dockerenv") || Boolean(env.DOCKER_CONTAINER);
    return {
        port: intEnv(env.PORT, 3000),
        runningInDocker,
        dataDir,
        dbPath: join(dataDir, "app.db"),
        schemaPath,
        webDistDir,
        version: readVersion(projectRoot),
        secret: textEnv(env.SESSION_SECRET, loadOrCreateSecret(dataDir)),
        adminUsername: textEnv(env.ADMIN_USERNAME, "admin"),
        adminPassword: env.ADMIN_PASSWORD?.trim() || null,
        trustProxy: textEnv(env.TRUST_PROXY, "0") !== "0",
        defaultQuota: defaultQuotaPolicy(env),
        maxBodyBytes: intEnv(env.RELAY_MAX_BODY_MB, 128) * 1024 * 1024,
        relayTimeoutMs: intEnv(env.RELAY_TIMEOUT_MS, 600_000),
        mediaTimeoutMs: intEnv(env.RELAY_MEDIA_TIMEOUT_MS, 120_000),
        analyticsGa4Id: textEnv(env.ANALYTICS_GA4_ID, ""),
        analyticsBaiduId: textEnv(env.ANALYTICS_BAIDU_ID, ""),
    };
}

/** 静态托管时生成 /config.js 用；保留上游统计配置语义。 */
export function analyticsConfigScript(config: ServerConfig): string {
    return `window.__RUNTIME_CONFIG__ = ${JSON.stringify({
        ANALYTICS_GA4_ID: config.analyticsGa4Id,
        ANALYTICS_BAIDU_ID: config.analyticsBaiduId,
        SERVER_MODE: true,
    })};\n`;
}

export function ensureParentDir(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
}
