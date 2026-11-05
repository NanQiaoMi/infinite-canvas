import { afterEach, describe, expect, test } from "bun:test";

import { setNowForTests } from "../src/clock";
import { isoWithOffset, nextDayStart, nextWeekStart, quotaStatusFor, reserveQuota, resetUsage, settleQuota, startOfDay, startOfWeek } from "../src/quota";
import { createTestDb, insertClient, testPolicy } from "./helpers";

afterEach(() => setNowForTests(null));

describe("额度窗口（时区）", () => {
    test("Asia/Shanghai 日/周边界", () => {
        const now = Date.UTC(2026, 10, 5, 16, 0, 0); // 2026-11-06 00:00:00 +08:00
        expect(startOfDay(now, "Asia/Shanghai")).toBe(now);
        expect(nextDayStart(now, "Asia/Shanghai")).toBe(now + 86_400_000);
        // 2026-11-06 是周五，周一为 2026-11-02 00:00 +08:00
        expect(startOfWeek(now, "Asia/Shanghai")).toBe(Date.UTC(2026, 10, 1, 16, 0, 0));
        expect(nextWeekStart(now, "Asia/Shanghai")).toBe(Date.UTC(2026, 10, 8, 16, 0, 0));
        expect(isoWithOffset(now, "Asia/Shanghai")).toBe("2026-11-06T00:00:00+08:00");
    });

    test("UTC 日边界与 ISO 周起点", () => {
        const now = Date.UTC(2026, 10, 5, 13, 45, 12); // 2026-11-05 周四
        expect(startOfDay(now, "UTC")).toBe(Date.UTC(2026, 10, 5, 0, 0, 0));
        expect(startOfWeek(now, "UTC")).toBe(Date.UTC(2026, 10, 2, 0, 0, 0));
        expect(isoWithOffset(startOfDay(now, "UTC"), "UTC")).toBe("2026-11-05T00:00:00+00:00");
    });
});

describe("额度预占与结算", () => {
    test("图片日额度按张数限制", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy({ image: { daily: 3, weekly: 100 } });

        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 2, {}, now).ok).toBe(true);
        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, now).ok).toBe(true);
        const blocked = reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, now);
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) expect(blocked.failure).toMatchObject({ scope: "daily", capability: "image", dimension: "client" });
    });

    test("失败释放（released）不占用额度", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy({ image: { daily: 1, weekly: 10 } });

        const first = reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, now);
        expect(first.ok).toBe(true);
        if (first.ok) settleQuota(db, first.eventId, "released", 500);
        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, now).ok).toBe(true);
    });

    test("周额度跨日累计，周一切换新窗口", () => {
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy({ image: { daily: 100, weekly: 2 } });
        const sunday = Date.UTC(2026, 10, 8, 4, 0, 0); // 2026-11-08 周日 12:00 +08
        const monday = Date.UTC(2026, 10, 9, 4, 0, 0); // 2026-11-09 周一 12:00 +08

        expect(reserveQuota(db, policy, client, "1.1.1.1", "image", 1, {}, sunday).ok).toBe(true);
        expect(reserveQuota(db, policy, client, "1.1.1.1", "image", 1, {}, sunday).ok).toBe(true);
        const blockedSunday = reserveQuota(db, policy, client, "1.1.1.1", "image", 1, {}, sunday);
        expect(blockedSunday.ok).toBe(false);
        if (!blockedSunday.ok) expect(blockedSunday.failure.scope).toBe("weekly");
        expect(reserveQuota(db, policy, client, "1.1.1.1", "image", 1, {}, monday).ok).toBe(true);
    });

    test("IP 维度上限跨访客生效", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        const db = createTestDb();
        const clientA = insertClient(db, "client-a", "fp-aaaaaaaaaa");
        const clientB = insertClient(db, "client-b", "fp-bbbbbbbbbb");
        const policy = testPolicy({ image: { daily: 100, weekly: 1000, ipDaily: 2, ipWeekly: 0 } });

        expect(reserveQuota(db, policy, clientA, "9.9.9.9", "image", 2, {}, now).ok).toBe(true);
        const blocked = reserveQuota(db, policy, clientB, "9.9.9.9", "image", 1, {}, now);
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) expect(blocked.failure).toMatchObject({ dimension: "ip", scope: "daily" });
        expect(reserveQuota(db, policy, clientB, "8.8.8.8", "image", 1, {}, now).ok).toBe(true);
    });

    test("不限额能力不会被拦截", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy();
        for (let index = 0; index < 50; index += 1) {
            expect(reserveQuota(db, policy, client, "127.0.0.1", "text", 1, {}, now).ok).toBe(true);
        }
    });

    test("手动重置清零当前日窗口但保留周用量", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy({ image: { daily: 1, weekly: 10 } });

        const first = reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, now);
        expect(first.ok).toBe(true);
        if (first.ok) settleQuota(db, first.eventId, "committed", 200);
        expect(quotaStatusFor(db, policy, client, now).capabilities.image.dailyUsed).toBe(1);

        const changes = resetUsage(db, policy, { kind: "client", id: client.id }, "daily", null, now);
        expect(changes).toBe(1);
        const status = quotaStatusFor(db, policy, client, now);
        expect(status.capabilities.image.dailyUsed).toBe(0);
        expect(status.capabilities.image.weeklyUsed).toBe(1);
        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, now).ok).toBe(true);
    });

    test("跨天后日额度自动恢复", () => {
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy({ image: { daily: 1, weekly: 100 } });
        const dayOne = Date.UTC(2026, 10, 4, 4, 0, 0);
        const dayTwo = Date.UTC(2026, 10, 5, 4, 0, 0);

        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, dayOne).ok).toBe(true);
        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, dayOne).ok).toBe(false);
        expect(reserveQuota(db, policy, client, "127.0.0.1", "image", 1, {}, dayTwo).ok).toBe(true);
    });
});

describe("额度状态", () => {
    test("返回分能力用量、上限与重置时间", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        const db = createTestDb();
        const client = insertClient(db);
        const policy = testPolicy({ image: { daily: 100, weekly: 700 } });
        const reservation = reserveQuota(db, policy, client, "127.0.0.1", "image", 3, {}, now);
        expect(reservation.ok).toBe(true);
        if (reservation.ok) settleQuota(db, reservation.eventId, "committed", 200);

        const status = quotaStatusFor(db, policy, client, now);
        expect(status.capabilities.image.dailyUsed).toBe(3);
        expect(status.capabilities.image.dailyLimit).toBe(100);
        expect(status.capabilities.text.dailyLimit).toBe(0);
        expect(status.dailyResetAt).toBe("2026-11-06T00:00:00+08:00");
        expect(status.weeklyResetAt).toBe("2026-11-09T00:00:00+08:00");
    });

    test("测试时钟可推进窗口", () => {
        const now = Date.UTC(2026, 10, 5, 4, 0, 0);
        setNowForTests(now);
        expect(nextDayStart(now, "Asia/Shanghai")).toBe(Date.UTC(2026, 10, 5, 16, 0, 0));
        setNowForTests(null);
    });
});
