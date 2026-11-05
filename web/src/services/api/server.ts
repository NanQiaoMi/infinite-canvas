import type {
    AdminChannel,
    AdminChannelInput,
    AdminClientDetail,
    AdminClientsResponse,
    AdminOverview,
    AdminQuotaPolicy,
    AdminSessionInfo,
    AdminSettingsResponse,
    AdminUsageResponse,
    BootstrapResponse,
    CapabilityUsage,
    PublicSettings,
    QuotaResponse,
    ServerCapability,
    ServerErrorBody,
    SessionResponse,
} from "@/types/server";

export class ServerApiError extends Error {
    status: number;
    code?: string;
    body?: ServerErrorBody;

    constructor(message: string, status: number, body?: ServerErrorBody) {
        super(message);
        this.name = "ServerApiError";
        this.status = status;
        this.body = body;
        this.code = body?.code;
    }
}

async function parseResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let data: unknown = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!response.ok) {
        const body = (data ?? {}) as ServerErrorBody;
        const message = body.error?.message || `请求失败（HTTP ${response.status}）`;
        throw new ServerApiError(message, response.status, body);
    }
    return data as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...init, headers, cache: "no-store" });
    return parseResponse<T>(response);
}

export type FingerprintPayload = {
    visitorId: string;
    source: string;
    ua?: string;
    lang?: string;
    timezone?: string;
};

/** 探测服务端模式；失败（静态部署 / 非服务端）返回 null。 */
export async function detectServer(timeoutMs = 3000): Promise<BootstrapResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const data = await request<BootstrapResponse>("/api/bootstrap", { signal: controller.signal });
        return data && data.serverMode ? data : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function registerFingerprint(payload: FingerprintPayload): Promise<SessionResponse> {
    return request<SessionResponse>("/api/session/fingerprint", { method: "POST", body: JSON.stringify(payload) });
}

export async function fetchQuota(): Promise<QuotaResponse> {
    return request<QuotaResponse>("/api/quota");
}

export type AdminChannelListResponse = {
    channels: AdminChannel[];
    defaultModels: Record<ServerCapability, string>;
};

export type AdminChannelsResponse = {
    ok: true;
    channels: AdminChannel[];
    defaultModels: Record<ServerCapability, string>;
};

export type AdminChannelsTestInput = {
    baseUrl?: string;
    apiKey?: string;
    apiFormat?: string;
    channelId?: string;
};

export type QuoteMetrics = {
    dailyUsed: number;
    dailyLimit: number;
    weeklyUsed: number;
    weeklyLimit: number;
};

export const serverApi = {
    detect: detectServer,
    registerFingerprint,
    quota: fetchQuota,
    bootstrap: async () => request<BootstrapResponse>("/api/bootstrap"),
    admin: {
        login: (username: string, password: string) => request<{ ok: true }>("/api/admin/login", { method: "POST", body: JSON.stringify({ username, password }) }),
        logout: () => request<{ ok: true }>("/api/admin/logout", { method: "POST" }),
        session: () => request<AdminSessionInfo>("/api/admin/session"),
        overview: () => request<AdminOverview>("/api/admin/overview"),
        channels: () => request<AdminChannelListResponse>("/api/admin/channels"),
        saveChannels: (channels: AdminChannelInput[], defaultModels?: Record<string, string>) =>
            request<AdminChannelsResponse>("/api/admin/channels", { method: "PUT", body: JSON.stringify({ channels, defaultModels }) }),
        testChannel: (input: AdminChannelsTestInput) => request<{ ok: true; models: string[] }>("/api/admin/channels/test", { method: "POST", body: JSON.stringify(input) }),
        quotaPolicy: () => request<{ policy: AdminQuotaPolicy }>("/api/admin/quota-policy"),
        saveQuotaPolicy: (policy: AdminQuotaPolicy) => request<{ ok: true; policy: AdminQuotaPolicy }>("/api/admin/quota-policy", { method: "PUT", body: JSON.stringify({ policy }) }),
        usage: (days = 7) => request<AdminUsageResponse>(`/api/admin/usage?days=${encodeURIComponent(String(days))}`),
        clients: (params: { q?: string; page?: number; pageSize?: number } = {}) => {
            const search = new URLSearchParams();
            if (params.q) search.set("q", params.q);
            if (params.page) search.set("page", String(params.page));
            if (params.pageSize) search.set("pageSize", String(params.pageSize));
            const query = search.toString();
            return request<AdminClientsResponse>(`/api/admin/clients${query ? `?${query}` : ""}`);
        },
        client: (id: string) => request<AdminClientDetail>(`/api/admin/clients/${encodeURIComponent(id)}`),
        resetClientQuota: (id: string, scope: "daily" | "weekly" | "all", capability?: ServerCapability) =>
            request<{ ok: true; changes: number }>(`/api/admin/clients/${encodeURIComponent(id)}/reset-quota`, { method: "POST", body: JSON.stringify({ scope, capability }) }),
        blockClient: (id: string, blocked: boolean) => request<{ ok: true; blocked: boolean }>(`/api/admin/clients/${encodeURIComponent(id)}/block`, { method: "POST", body: JSON.stringify({ blocked }) }),
        resetAllQuota: (scope: "daily" | "weekly" | "all", capability?: ServerCapability) =>
            request<{ ok: true; changes: number }>("/api/admin/quota/reset-all", { method: "POST", body: JSON.stringify({ scope, capability }) }),
        settings: () => request<AdminSettingsResponse>("/api/admin/settings"),
        saveSettings: (input: { publicSettings?: PublicSettings; systemSettings?: { retentionDays: number }; defaultModels?: Record<string, string> }) =>
            request<{ ok: true; publicSettings: PublicSettings; systemSettings: { retentionDays: number }; defaultModels: Record<ServerCapability, string> }>("/api/admin/settings", { method: "PUT", body: JSON.stringify(input) }),
        changePassword: (oldPassword: string, newPassword: string) => request<{ ok: true }>("/api/admin/password", { method: "POST", body: JSON.stringify({ oldPassword, newPassword }) }),
    },
};

export type { CapabilityUsage };
