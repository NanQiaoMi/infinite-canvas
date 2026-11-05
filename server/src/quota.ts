import type { Database } from "bun:sqlite";

import { nowMs } from "./clock";
import { getJsonSetting, setJsonSetting, transaction } from "./db";
import type { Capability, CapabilityLimits, CapabilityUsage, ClientRecord, QuotaPolicy, QuotaStatus } from "./types";
import { CAPABILITIES } from "./types";

export const QUOTA_POLICY_KEY = "quota_policy";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ---------- 策略读写 ----------

export function loadQuotaPolicy(db: Database, defaults: QuotaPolicy): QuotaPolicy {
    const stored = getJsonSetting<Partial<QuotaPolicy>>(db, QUOTA_POLICY_KEY);
    if (!stored) {
        setJsonSetting(db, QUOTA_POLICY_KEY, defaults);
        return defaults;
    }
    const capabilities = { ...defaults.capabilities } as Record<Capability, CapabilityLimits>;
    for (const capability of CAPABILITIES) {
        const storedLimits = stored.capabilities?.[capability];
        if (storedLimits) capabilities[capability] = { ...capabilities[capability], ...storedLimits };
    }
    return {
        timezone: stored.timezone || defaults.timezone,
        adminExempt: stored.adminExempt ?? defaults.adminExempt,
        refundOnFailure: stored.refundOnFailure ?? defaults.refundOnFailure,
        capabilities,
    };
}

export function saveQuotaPolicy(db: Database, policy: QuotaPolicy) {
    setJsonSetting(db, QUOTA_POLICY_KEY, policy);
}

// ---------- 时区窗口 ----------

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    const cached = formatterCache.get(timeZone);
    if (cached) return cached;
    const created = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    formatterCache.set(timeZone, created);
    return created;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
    const values: Record<string, number> = {};
    for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
        if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    const year = values.year;
    const month = values.month;
    const day = values.day;
    return {
        year,
        month,
        day,
        hour: values.hour,
        minute: values.minute,
        second: values.second,
        weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    };
}

function offsetAt(ms: number, timeZone: string): number {
    const parts = zonedParts(ms, timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 把「该时区的某个本地日期 00:00」换算成 UTC 毫秒（含 DST 两段修正）。 */
function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string, reference: number): number {
    const localAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
    const firstGuess = localAsUtc - offsetAt(reference, timeZone);
    return localAsUtc - offsetAt(firstGuess, timeZone);
}

export function startOfDay(ms: number, timeZone: string): number {
    const parts = zonedParts(ms, timeZone);
    return zonedMidnightUtc(parts.year, parts.month, parts.day, timeZone, ms);
}

/** ISO 周：周一为起点。 */
export function startOfWeek(ms: number, timeZone: string): number {
    const parts = zonedParts(ms, timeZone);
    const daysSinceMonday = (parts.weekday + 6) % 7;
    return zonedMidnightUtc(parts.year, parts.month, parts.day - daysSinceMonday, timeZone, ms);
}

export function nextDayStart(ms: number, timeZone: string): number {
    const parts = zonedParts(ms, timeZone);
    return zonedMidnightUtc(parts.year, parts.month, parts.day + 1, timeZone, ms);
}

export function nextWeekStart(ms: number, timeZone: string): number {
    // 先定位本周起点，再前进 8 天重新取周起点，跨月/跨年/DST 都成立。
    return startOfWeek(startOfWeek(ms, timeZone) + 8 * DAY, timeZone);
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

export function isoWithOffset(ms: number, timeZone: string): string {
    const parts = zonedParts(ms, timeZone);
    const offset = offsetAt(ms, timeZone);
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset);
    const hours = pad(Math.floor(abs / 3_600_000));
    const minutes = pad(Math.floor((abs % 3_600_000) / 60_000));
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${hours}:${minutes}`;
}

// ---------- 用量统计 ----------

function usedUnits(db: Database, column: "client_id" | "ip", id: string, capability: Capability, since: number): number {
    const row = db
        .query(`SELECT COALESCE(SUM(units), 0) AS total FROM usage_events WHERE ${column} = ? AND capability = ? AND state IN ('reserved', 'committed') AND created_at >= ?`)
        .get(id, capability, since) as { total: number } | null;
    return Number(row?.total ?? 0);
}

/** 某个访客/能力/窗口最近一次手动重置的时间点（0 表示没有重置）。 */
function resetCutoffForClient(db: Database, clientId: string, capability: Capability, window: "daily" | "weekly"): number {
    const row = db
        .query("SELECT MAX(created_at) AS at FROM quota_resets WHERE window = ? AND (scope = 'all' OR (scope = 'client' AND target = ?)) AND (capability = '' OR capability = ?)")
        .get(window, clientId, capability) as { at: number | null } | null;
    return Number(row?.at ?? 0);
}

function effectiveSince(windowStart: number, cutoff: number): number {
    // 重置标记与同一毫秒内产生的用量不可区分，统一把起点推后 1ms。
    return cutoff > 0 ? Math.max(windowStart, cutoff + 1) : windowStart;
}

function resetCutoffForIp(db: Database, ip: string, capability: Capability, window: "daily" | "weekly"): number {
    const row = db
        .query("SELECT MAX(created_at) AS at FROM quota_resets WHERE window = ? AND (scope = 'all' OR (scope = 'ip' AND target = ?)) AND (capability = '' OR capability = ?)")
        .get(window, ip, capability) as { at: number | null } | null;
    return Number(row?.at ?? 0);
}

export function quotaStatusFor(db: Database, policy: QuotaPolicy, client: ClientRecord, now = nowMs(), exempt = false): QuotaStatus {
    const dayStart = startOfDay(now, policy.timezone);
    const weekStart = startOfWeek(now, policy.timezone);
    const capabilities = {} as Record<Capability, CapabilityUsage>;
    for (const capability of CAPABILITIES) {
        const limits = policy.capabilities[capability];
        const dailySince = effectiveSince(dayStart, resetCutoffForClient(db, client.id, capability, "daily"));
        const weeklySince = effectiveSince(weekStart, resetCutoffForClient(db, client.id, capability, "weekly"));
        capabilities[capability] = {
            dailyUsed: usedUnits(db, "client_id", client.id, capability, dailySince),
            dailyLimit: limits.daily,
            weeklyUsed: usedUnits(db, "client_id", client.id, capability, weeklySince),
            weeklyLimit: limits.weekly,
        };
    }
    return {
        dailyResetAt: isoWithOffset(nextDayStart(now, policy.timezone), policy.timezone),
        weeklyResetAt: isoWithOffset(nextWeekStart(now, policy.timezone), policy.timezone),
        exempt: policy.adminExempt && exempt,
        capabilities,
    };
}

// ---------- 预占 / 结算 / 释放 ----------

export type ReserveFailure = {
    scope: "daily" | "weekly";
    capability: Capability;
    dimension: "client" | "ip";
};

export type ReserveResult = { ok: true; eventId: number } | { ok: false; failure: ReserveFailure };

export type UsageMeta = { model?: string; endpoint?: string };

export function reserveQuota(
    db: Database,
    policy: QuotaPolicy,
    client: ClientRecord,
    ip: string,
    capability: Capability,
    units: number,
    meta: UsageMeta = {},
    now = nowMs(),
): ReserveResult {
    const normalizedUnits = Math.max(1, Math.floor(units));
    return transaction(db, (): ReserveResult => {
        const limits = policy.capabilities[capability];
        const dayStart = startOfDay(now, policy.timezone);
        const weekStart = startOfWeek(now, policy.timezone);
        const clientDailySince = effectiveSince(dayStart, resetCutoffForClient(db, client.id, capability, "daily"));
        const clientWeeklySince = effectiveSince(weekStart, resetCutoffForClient(db, client.id, capability, "weekly"));
        const ipDailySince = effectiveSince(dayStart, resetCutoffForIp(db, ip, capability, "daily"));
        const ipWeeklySince = effectiveSince(weekStart, resetCutoffForIp(db, ip, capability, "weekly"));

        if (limits.daily > 0 && usedUnits(db, "client_id", client.id, capability, clientDailySince) + normalizedUnits > limits.daily) {
            return { ok: false, failure: { scope: "daily", capability, dimension: "client" } };
        }
        if (limits.weekly > 0 && usedUnits(db, "client_id", client.id, capability, clientWeeklySince) + normalizedUnits > limits.weekly) {
            return { ok: false, failure: { scope: "weekly", capability, dimension: "client" } };
        }
        if (limits.ipDaily > 0 && usedUnits(db, "ip", ip, capability, ipDailySince) + normalizedUnits > limits.ipDaily) {
            return { ok: false, failure: { scope: "daily", capability, dimension: "ip" } };
        }
        if (limits.ipWeekly > 0 && usedUnits(db, "ip", ip, capability, ipWeeklySince) + normalizedUnits > limits.ipWeekly) {
            return { ok: false, failure: { scope: "weekly", capability, dimension: "ip" } };
        }

        db.query(
            "INSERT INTO usage_events (client_id, ip, fingerprint, capability, model, endpoint, units, state, upstream_status, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, NULL)",
        ).run(client.id, ip, client.fingerprint, capability, meta.model || "", meta.endpoint || "", normalizedUnits, now);
        const row = db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
        return { ok: true, eventId: Number(row.id) };
    });
}

export function settleQuota(db: Database, eventId: number, state: "committed" | "released", upstreamStatus: number | null) {
    db.query("UPDATE usage_events SET state = ?, upstream_status = ?, settled_at = ? WHERE id = ? AND state = 'reserved'").run(state, upstreamStatus, nowMs(), eventId);
}

// ---------- 手动重置 ----------

export type ResetScope = { kind: "client"; id: string } | { kind: "ip"; id: string } | { kind: "all" };

/**
 * 手动重置：写入一条重置标记，而不是改写历史事件。
 * 用量统计以「窗口起点」与「最近重置时间」中较晚者为起点，因此：
 * - 重置日窗口不影响周窗口用量；
 * - 重置只影响当前窗口，历史用量与审计记录保持完整。
 */
export function resetUsage(db: Database, policy: QuotaPolicy, scope: ResetScope, window: "daily" | "weekly", capability: Capability | null, now = nowMs()): number {
    void policy;
    const scopeKey = scope.kind === "client" ? "client" : scope.kind === "ip" ? "ip" : "all";
    const target = scope.kind === "all" ? "" : scope.id;
    db.query("INSERT INTO quota_resets (scope, target, capability, window, created_at) VALUES (?, ?, ?, ?, ?)").run(scopeKey, target, capability ?? "", window, now);
    return 1;
}

// ---------- 统计 / 清理 ----------

export function usageTotals(db: Database, from: number, to: number): Array<{ capability: Capability; units: number; requests: number }> {
    const rows = db
        .query(
            "SELECT capability, COALESCE(SUM(units), 0) AS units, COUNT(*) AS requests FROM usage_events WHERE state IN ('reserved', 'committed') AND created_at >= ? AND created_at < ? GROUP BY capability",
        )
        .all(from, to) as Array<{ capability: Capability; units: number; requests: number }>;
    return rows.map((row) => ({ capability: row.capability, units: Number(row.units), requests: Number(row.requests) }));
}

export function usageSince(db: Database, column: "client_id" | "ip", id: string, since: number): Record<Capability, number> {
    const result = { image: 0, video: 0, text: 0, audio: 0 } as Record<Capability, number>;
    const rows = db
        .query(
            `SELECT capability, COALESCE(SUM(units), 0) AS units FROM usage_events WHERE ${column} = ? AND state IN ('reserved', 'committed') AND created_at >= ? GROUP BY capability`,
        )
        .all(id, since) as Array<{ capability: Capability; units: number }>;
    for (const row of rows) {
        if (row.capability in result) result[row.capability] = Number(row.units);
    }
    return result;
}

export function cleanupUsageEvents(db: Database, retentionDays: number, now = nowMs()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * DAY;
    const result = db.query("DELETE FROM usage_events WHERE created_at < ? AND state IN ('committed', 'released')").run(cutoff);
    db.query("DELETE FROM quota_resets WHERE created_at < ?").run(cutoff);
    return result.changes ?? 0;
}
