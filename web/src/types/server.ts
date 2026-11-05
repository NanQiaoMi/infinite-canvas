export type ServerCapability = "image" | "video" | "text" | "audio";

export type ServerApiFormat = "openai" | "gemini";

export type ServerChannelModel = {
    name: string;
    capability: ServerCapability;
    script?: string;
};

export type ServerChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ServerApiFormat;
    models: ServerChannelModel[];
};

export type CapabilityLimits = {
    daily: number;
    weekly: number;
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
    capabilities: Record<ServerCapability, CapabilityUsage>;
};

export type PublicSettings = {
    allowModelSelection: boolean;
    announcement: string;
};

export type BootstrapResponse = {
    serverMode: true;
    version: string;
    channels: ServerChannel[];
    defaultModels: Record<ServerCapability, string>;
    quotaPolicy: {
        timezone: string;
        capabilities: Record<ServerCapability, CapabilityLimits>;
    };
    quota: QuotaStatus | null;
    publicSettings: PublicSettings;
    admin: boolean;
};

export type SessionResponse = {
    clientId: string;
    blocked: boolean;
    quota: QuotaStatus;
    publicSettings: PublicSettings;
};

export type QuotaResponse = {
    quota: QuotaStatus;
    blocked: boolean;
};

export type AdminSessionInfo = {
    admin: true;
    username: string;
    expiresAt: number;
};

export type AdminChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ServerApiFormat;
    enabled: boolean;
    apiKeyMasked: string;
    hasApiKey: boolean;
    models: ServerChannelModel[];
};

export type AdminChannelInput = {
    id?: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    apiFormat?: ServerApiFormat;
    enabled?: boolean;
    models?: Array<{ name?: string; capability?: ServerCapability; script?: string }>;
};

export type AdminQuotaLimits = {
    daily: number;
    weekly: number;
    ipDaily: number;
    ipWeekly: number;
};

export type AdminQuotaPolicy = {
    timezone: string;
    capabilities: Record<ServerCapability, AdminQuotaLimits>;
    adminExempt: boolean;
    refundOnFailure: boolean;
};

export type AdminUsageEvent = {
    id: number;
    client_id: string;
    ip: string;
    fingerprint: string;
    capability: ServerCapability;
    model: string;
    endpoint: string;
    units: number;
    state: "reserved" | "committed" | "released" | "reset";
    upstream_status: number | null;
    created_at: number;
    settled_at: number | null;
};

export type AdminOverview = {
    version: string;
    uptimeSeconds: number;
    channels: { total: number; enabled: number };
    clients: { total: number; activeToday: number };
    usage: {
        today: Array<{ capability: ServerCapability; units: number; requests: number }>;
        week: Array<{ capability: ServerCapability; units: number; requests: number }>;
    };
};

export type AdminUsageResponse = {
    days: number;
    totals: Array<{ capability: ServerCapability; units: number; requests: number }>;
    daily: Array<{ date: string; label: string; capabilities: Record<string, { units: number; requests: number }> }>;
    recent: AdminUsageEvent[];
};

export type AdminClientItem = {
    id: string;
    fingerprint: string;
    fingerprintSource: string;
    userAgent: string;
    firstIp: string;
    lastIp: string;
    firstSeenAt: number;
    lastSeenAt: number;
    blocked: boolean;
    ipCount: number;
    usage: {
        today: Record<ServerCapability, number>;
        week: Record<ServerCapability, number>;
    };
};

export type AdminClientsResponse = {
    page: number;
    pageSize: number;
    total: number;
    items: AdminClientItem[];
};

export type AdminClientDetail = {
    client: {
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
    quota: QuotaStatus;
    ips: Array<{ ip: string; first_seen_at: number; last_seen_at: number; hits: number }>;
    events: AdminUsageEvent[];
};

export type AdminPublicSettings = PublicSettings;

export type AdminSystemSettings = {
    retentionDays: number;
};

export type AdminSettingsResponse = {
    publicSettings: PublicSettings;
    systemSettings: AdminSystemSettings;
    defaultModels: Record<ServerCapability, string>;
    server: { version: string; uptimeSeconds: number };
};

export type ServerErrorBody = {
    error?: { message?: string };
    code?: string;
    scope?: string;
    capability?: string;
    dimension?: string;
    quota?: CapabilityUsage & { dailyResetAt?: string; weeklyResetAt?: string };
};
