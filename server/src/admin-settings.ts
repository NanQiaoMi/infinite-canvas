import type { Database } from "bun:sqlite";

import { getJsonSetting, setJsonSetting } from "./db";
import type { Capability, CapabilityLimits, PublicSettings, QuotaPolicy } from "./types";
import { CAPABILITIES } from "./types";

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
    allowModelSelection: true,
    announcement: "",
};

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
    retentionDays: 90,
};

export type SystemSettings = {
    retentionDays: number;
};

const PUBLIC_SETTINGS_KEY = "public_settings";
const SYSTEM_SETTINGS_KEY = "system_settings";

export function loadPublicSettings(db: Database): PublicSettings {
    const stored = getJsonSetting<Partial<PublicSettings>>(db, PUBLIC_SETTINGS_KEY) ?? {};
    return {
        allowModelSelection: stored.allowModelSelection ?? DEFAULT_PUBLIC_SETTINGS.allowModelSelection,
        announcement: typeof stored.announcement === "string" ? stored.announcement.slice(0, 2000) : DEFAULT_PUBLIC_SETTINGS.announcement,
    };
}

export function savePublicSettings(db: Database, input: Partial<PublicSettings>): PublicSettings {
    const next: PublicSettings = {
        allowModelSelection: input.allowModelSelection ?? loadPublicSettings(db).allowModelSelection,
        announcement: typeof input.announcement === "string" ? input.announcement.slice(0, 2000) : loadPublicSettings(db).announcement,
    };
    setJsonSetting(db, PUBLIC_SETTINGS_KEY, next);
    return next;
}

export function loadSystemSettings(db: Database): SystemSettings {
    const stored = getJsonSetting<Partial<SystemSettings>>(db, SYSTEM_SETTINGS_KEY) ?? {};
    const retentionDays = Number(stored.retentionDays);
    return { retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : DEFAULT_SYSTEM_SETTINGS.retentionDays };
}

export function saveSystemSettings(db: Database, input: Partial<SystemSettings>): SystemSettings {
    const current = loadSystemSettings(db);
    const retentionDays = Number(input.retentionDays);
    const next: SystemSettings = {
        retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0 ? Math.min(3650, Math.floor(retentionDays)) : current.retentionDays,
    };
    setJsonSetting(db, SYSTEM_SETTINGS_KEY, next);
    return next;
}

/** 公共额度视图：只暴露每个能力的日/周上限，不暴露 IP 维度策略。 */
export function resolvePublicDefaults(policy: QuotaPolicy): { timezone: string; capabilities: Record<Capability, Pick<CapabilityLimits, "daily" | "weekly">> } {
    const capabilities = {} as Record<Capability, Pick<CapabilityLimits, "daily" | "weekly">>;
    for (const capability of CAPABILITIES) {
        capabilities[capability] = { daily: policy.capabilities[capability].daily, weekly: policy.capabilities[capability].weekly };
    }
    return { timezone: policy.timezone, capabilities };
}
