import { create } from "zustand";

import { serverApi } from "@/services/api/server";
import type { QuotaStatus, ServerCapability } from "@/types/server";

type QuotaStore = {
    status: QuotaStatus | null;
    blocked: boolean;
    loading: boolean;
    setStatus: (status: QuotaStatus | null) => void;
    setBlocked: (blocked: boolean) => void;
    refresh: () => Promise<void>;
    /** 合并短时间内的多次刷新请求。 */
    scheduleRefresh: (delayMs?: number) => void;
};

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export const useQuotaStore = create<QuotaStore>()((set, get) => ({
    status: null,
    blocked: false,
    loading: false,
    setStatus: (status) => set({ status }),
    setBlocked: (blocked) => set({ blocked }),
    refresh: async () => {
        set({ loading: true });
        try {
            const data = await serverApi.quota();
            set({ status: data.quota, blocked: data.blocked });
        } catch {
            // 静态模式、会话尚未建立或网络异常时静默失败；真实请求仍由服务端强制校验。
        } finally {
            set({ loading: false });
        }
    },
    scheduleRefresh: (delayMs = 1500) => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void get().refresh();
        }, delayMs);
    },
}));

/** 某能力当前剩余额度；null 表示该维度不限额。 */
export function quotaRemaining(status: QuotaStatus | null, capability: ServerCapability): { daily: number | null; weekly: number | null } {
    const usage = status?.capabilities?.[capability];
    if (!usage) return { daily: null, weekly: null };
    return {
        daily: usage.dailyLimit > 0 ? Math.max(0, usage.dailyLimit - usage.dailyUsed) : null,
        weekly: usage.weeklyLimit > 0 ? Math.max(0, usage.weeklyLimit - usage.weeklyUsed) : null,
    };
}

export function quotaExhausted(status: QuotaStatus | null, capability: ServerCapability): boolean {
    const remaining = quotaRemaining(status, capability);
    return remaining.daily === 0 || remaining.weekly === 0;
}

export function quotaUsageCapabilities(status: QuotaStatus | null): ServerCapability[] {
    if (!status) return [];
    return (Object.keys(status.capabilities) as ServerCapability[]).filter((capability) => {
        const usage = status.capabilities[capability];
        return usage.dailyLimit > 0 || usage.weeklyLimit > 0;
    });
}
