import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { nowMs } from "./clock";
import { parseCookies } from "./http";
import { signValue, verifySignedValue } from "./security";
import type { ClientRecord } from "./types";

export const CLIENT_COOKIE = "ic_client";
export const CLIENT_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;

export type ClientRow = {
    id: string;
    fingerprint: string;
    fingerprint_source: string;
    user_agent: string;
    first_ip: string;
    last_ip: string;
    first_seen_at: number;
    last_seen_at: number;
    blocked: number;
    note: string;
};

export function mapClientRow(row: ClientRow): ClientRecord {
    return {
        id: row.id,
        fingerprint: row.fingerprint,
        fingerprintSource: row.fingerprint_source,
        userAgent: row.user_agent,
        firstIp: row.first_ip,
        lastIp: row.last_ip,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        blocked: row.blocked === 1,
        note: row.note,
    };
}

export function findClientById(db: Database, id: string): ClientRecord | null {
    const row = db.query("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | null;
    return row ? mapClientRow(row) : null;
}

export function getClientFromRequest(db: Database, secret: string, cookieHeader: string | null): ClientRecord | null {
    const cookies = parseCookies(cookieHeader);
    const raw = cookies[CLIENT_COOKIE];
    if (!raw) return null;
    const id = verifySignedValue(secret, raw);
    if (!id) return null;
    return findClientById(db, id);
}

export function clientCookieValue(secret: string, clientId: string): string {
    return signValue(secret, clientId);
}

function sanitizeFingerprint(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 160);
    if (cleaned.length >= 8) return cleaned;
    return `unknown-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeSource(value: unknown): string {
    return value === "fingerprintjs" ? "fingerprintjs" : "builtin";
}

function sanitizeUserAgent(value: unknown): string {
    return typeof value === "string" ? value.slice(0, 512) : "";
}

function touchClientIp(db: Database, clientId: string, ip: string, at: number) {
    if (!ip) return;
    db.query(
        "INSERT INTO client_ips (client_id, ip, first_seen_at, last_seen_at, hits) VALUES (?, ?, ?, ?, 1) ON CONFLICT(client_id, ip) DO UPDATE SET last_seen_at = excluded.last_seen_at, hits = client_ips.hits + 1",
    ).run(clientId, ip, at, at);
}

export type FingerprintInput = {
    fingerprint?: unknown;
    source?: unknown;
    userAgent?: unknown;
};

/**
 * 匿名访客注册/合并：
 * 1) 优先复用有效 Cookie 对应的访客；
 * 2) 否则按指纹复用最近一个访客记录（Cookie 丢失时不误伤额度）；
 * 3) 都没有则创建新访客。
 */
export function registerClient(db: Database, _secret: string, cookieHeader: string | null, ip: string, input: FingerprintInput): ClientRecord {
    const now = nowMs();
    const fingerprint = sanitizeFingerprint(input.fingerprint);
    const source = sanitizeSource(input.source);
    const userAgent = sanitizeUserAgent(input.userAgent);

    const fromCookie = getClientFromRequest(db, _secret, cookieHeader);
    if (fromCookie) {
        db.query("UPDATE clients SET fingerprint = ?, fingerprint_source = ?, user_agent = ?, last_ip = ?, last_seen_at = ? WHERE id = ?").run(
            fingerprint,
            source,
            userAgent,
            ip,
            now,
            fromCookie.id,
        );
        touchClientIp(db, fromCookie.id, ip, now);
        return findClientById(db, fromCookie.id) as ClientRecord;
    }

    const matched = db.query("SELECT * FROM clients WHERE fingerprint = ? ORDER BY last_seen_at DESC LIMIT 1").get(fingerprint) as ClientRow | null;
    if (matched) {
        db.query("UPDATE clients SET fingerprint_source = ?, user_agent = ?, last_ip = ?, last_seen_at = ? WHERE id = ?").run(source, userAgent, ip, now, matched.id);
        touchClientIp(db, matched.id, ip, now);
        return findClientById(db, matched.id) as ClientRecord;
    }

    const id = randomUUID();
    db.query(
        "INSERT INTO clients (id, fingerprint, fingerprint_source, user_agent, first_ip, last_ip, first_seen_at, last_seen_at, blocked, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '')",
    ).run(id, fingerprint, source, userAgent, ip, ip, now, now);
    touchClientIp(db, id, ip, now);
    return findClientById(db, id) as ClientRecord;
}

export function setClientBlocked(db: Database, clientId: string, blocked: boolean): boolean {
    const result = db.query("UPDATE clients SET blocked = ? WHERE id = ?").run(blocked ? 1 : 0, clientId);
    return (result.changes ?? 0) > 0;
}

export function listClientIps(db: Database, clientId: string) {
    return db.query("SELECT ip, first_seen_at, last_seen_at, hits FROM client_ips WHERE client_id = ? ORDER BY last_seen_at DESC").all(clientId) as Array<{
        ip: string;
        first_seen_at: number;
        last_seen_at: number;
        hits: number;
    }>;
}
