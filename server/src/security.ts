import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { nowMs } from "./clock";

// ---------- 签名 Cookie ----------

export function hmacSign(secret: string, value: string): string {
    return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signValue(secret: string, value: string): string {
    return `${value}.${hmacSign(secret, value)}`;
}

export function verifySignedValue(secret: string, signed: string | undefined): string | null {
    if (!signed) return null;
    const index = signed.lastIndexOf(".");
    if (index <= 0) return null;
    const value = signed.slice(0, index);
    const signature = signed.slice(index + 1);
    const expected = hmacSign(secret, value);
    if (signature.length !== expected.length) return null;
    try {
        return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? value : null;
    } catch {
        return null;
    }
}

// ---------- API Key 加密（AES-256-GCM） ----------

function aesKey(secret: string): Buffer {
    return createHash("sha256").update(`${secret}:infinite-canvas-aes`).digest();
}

export function encryptSecret(secret: string, plaintext: string): string {
    if (!plaintext) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aesKey(secret), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(secret: string, payload: string): string {
    if (!payload) return "";
    const [ivPart, tagPart, dataPart] = payload.split(".");
    if (!ivPart || !tagPart || !dataPart) return "";
    try {
        const decipher = createDecipheriv("aes-256-gcm", aesKey(secret), Buffer.from(ivPart, "base64url"));
        decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
    } catch {
        return "";
    }
}

export function maskSecret(secretValue: string): string {
    if (!secretValue) return "";
    if (secretValue.length <= 8) return "****";
    return `${secretValue.slice(0, 3)}****${secretValue.slice(-4)}`;
}

// ---------- 管理员密码 ----------

export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
        return await Bun.password.verify(password, hash);
    } catch {
        return false;
    }
}

export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

// ---------- 限流 ----------

type Bucket = { count: number; resetAt: number };

export class RateLimiter {
    private buckets = new Map<string, Bucket>();

    constructor(
        private limit: number,
        private windowMs: number,
    ) {}

    /** true 表示允许本次请求。 */
    hit(key: string, now = nowMs()): boolean {
        const bucket = this.buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
            return true;
        }
        if (bucket.count >= this.limit) return false;
        bucket.count += 1;
        return true;
    }

    reset(key: string) {
        this.buckets.delete(key);
    }

    cleanup(now = nowMs()) {
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= now) this.buckets.delete(key);
        }
    }
}

// ---------- SSRF 防护 ----------

const PRIVATE_V4_PATTERNS = [
    /^0\./,
    /^10\./,
    /^127\./,
    /^169\.254\./,
    /^192\.168\./,
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
];

export function isPrivateIp(raw: string): boolean {
    const ip = raw.trim().toLowerCase();
    if (!ip) return true;
    if (ip.includes(":")) {
        // IPv6
        if (ip === "::" || ip === "::1") return true;
        if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // link-local
        if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local
        if (ip.startsWith("::ffff:")) return isPrivateIp(ip.slice("::ffff:".length));
        return false;
    }
    return PRIVATE_V4_PATTERNS.some((pattern) => pattern.test(ip));
}

function normalizeHostname(hostname: string): string {
    return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * 校验主机名解析结果全部为公网地址，防止中转被用于访问内网 / 本机 / 云元数据。
 * 仅用于「非管理员配置渠道」的媒体 GET 转发；渠道白名单由管理员配置，视为可信。
 */
export async function assertPublicHost(hostname: string): Promise<void> {
    const host = normalizeHostname(hostname);
    if (!host) throw new Error("empty_host");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        throw new Error("private_host");
    }
    if (isIP(host)) {
        if (isPrivateIp(host)) throw new Error("private_address");
        return;
    }
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length) throw new Error("dns_no_record");
    for (const record of records) {
        if (isPrivateIp(record.address)) throw new Error("private_address");
    }
}

/** 规范化管理员配置的渠道 Base URL：仅允许 http(s)，禁止 userinfo/hash/query。 */
export function normalizeBaseUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("empty_base_url");
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new Error("invalid_base_url");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_protocol");
    if (url.username || url.password) throw new Error("userinfo_not_allowed");
    if (url.hash) throw new Error("hash_not_allowed");
    if (url.search) throw new Error("query_not_allowed");
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function isUrlUnderBase(target: string, base: string): boolean {
    const normalizedBase = base.replace(/\/+$/, "");
    if (target === normalizedBase) return true;
    return target.startsWith(`${normalizedBase}/`);
}


// ---------- Docker 内访问宿主机 ----------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 服务端运行在 Docker 内时，localhost/127.0.0.1 指向容器自身；
 * 管理员填写的本机服务地址统一改写为 host.docker.internal，避免「模型拉取为空/请求失败」。
 */
export function rewriteHostForDocker(value: string, runningInDocker: boolean): string {
    if (!runningInDocker || !value) return value;
    try {
        const url = new URL(value);
        if (!LOOPBACK_HOSTS.has(url.hostname)) return value;
        url.hostname = "host.docker.internal";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return value;
    }
}

export function rewriteUrlForDocker(target: URL, runningInDocker: boolean): URL {
    if (!runningInDocker || !LOOPBACK_HOSTS.has(target.hostname)) return target;
    const clone = new URL(target.toString());
    clone.hostname = "host.docker.internal";
    return clone;
}
