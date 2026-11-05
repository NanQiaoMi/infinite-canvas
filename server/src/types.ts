export type Capability = "image" | "video" | "text" | "audio";

export const CAPABILITIES: Capability[] = ["image", "video", "text", "audio"];

export type ApiFormat = "openai" | "gemini";

export type CapabilityLimits = {
    /** 0 表示不限额 */
    daily: number;
    /** 0 表示不限额 */
    weekly: number;
    /** 0 表示关闭 */
    ipDaily: number;
    /** 0 表示关闭 */
    ipWeekly: number;
};

export type QuotaPolicy = {
    timezone: string;
    capabilities: Record<Capability, CapabilityLimits>;
    adminExempt: boolean;
    refundOnFailure: boolean;
};

export type PublicSettings = {
    allowModelSelection: boolean;
    announcement: string;
};

export type ChannelModelRecord = {
    name: string;
    capability: Capability;
    script?: string;
};

export type ChannelRecord = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ApiFormat;
    enabled: boolean;
    models: ChannelModelRecord[];
};

export type PublicChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ApiFormat;
    models: ChannelModelRecord[];
};

export type ClientRecord = {
    id: string;
    fingerprint: string;
    fingerprintSource: string;
    userAgent: string;
    firstIp: string;
    lastIp: string;
    firstSeenAt: number;
    lastSeenAt: number;
    blocked: boolean;
    note: string;
};

export type CapabilityUsage = {
    dailyUsed: number;
    dailyLimit: number;
    weeklyUsed: number;
    weeklyLimit: number;
};

export type QuotaStatus = {
    dailyResetAt: string;
    weeklyResetAt: string;
    exempt: boolean;
    capabilities: Record<Capability, CapabilityUsage>;
};

export type AdminSession = {
    tokenHash: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
};

export type UsageEvent = {
    id: number;
    clientId: string;
    ip: string;
    capability: Capability;
    model: string;
    endpoint: string;
    units: number;
    state: "reserved" | "committed" | "released" | "reset";
    upstreamStatus: number | null;
    createdAt: number;
    settledAt: number | null;
};
