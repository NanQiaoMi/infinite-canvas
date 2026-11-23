import i18n from "@/i18n";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { useAgentStore, type AgentConversationState, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";

type AgentConfigResponse = { ok?: boolean; protocolVersion?: number; url?: string; token?: string; hasToken?: boolean };
const AGENT_MESSAGE_ASSET_PATTERN = /^agent-asset:([a-f0-9]{64})\/([a-f0-9]{64}\.(?:gif|jpe?g|png|webp))$/;

export class AgentApiError<T = unknown> extends Error {
    constructor(readonly status: number, readonly response: T & { code?: string; error?: string; msg?: string }) {
        super(response.error || response.msg || i18n.t("agent.state.requestFailed"));
        this.name = "AgentApiError";
    }
}

export type AgentSkillScope = "user" | "repo" | "system" | "admin";
export type AgentSkillInterface = { displayName?: string | null; shortDescription?: string | null; defaultPrompt?: string | null };
export type AgentSkillSummary = {
    name: string;
    description: string;
    shortDescription?: string | null;
    interface?: AgentSkillInterface | null;
    dependencies?: unknown;
    path: string;
    scope: AgentSkillScope;
    enabled: boolean;
    managed: boolean;
};
export type AgentSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: AgentSkillInterface | null;
    path: string;
    managed: true;
    revision: string;
};
export type AgentSkillInput = { name?: string; description: string; instructions: string; interface?: AgentSkillInterface | null; expectedRevision?: string };
export type AgentSkillDraft = { name: string; displayName: string; description: string; instructions: string; shortDescription: string; defaultPrompt: string };
export type AgentSkillDraftInput = { source: "conversation" | "canvas"; threadId: string; clientId: string; model?: string; effort?: AgentReasoningEffort };
export type AgentSkillsResponse = { ok?: boolean; data?: AgentSkillSummary[]; errors?: unknown[] };
export type AgentSkillResponse = { ok?: boolean; data?: AgentSkillDetail };
export type AgentSkillDraftResponse = { ok?: boolean; data?: AgentSkillDraft };

export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST" });
    } catch {}
}

export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetchAgentJson(endpoint, token, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function postCodexApproval(endpoint: string, token: string, requestId: string, decision: "accept" | "acceptForSession" | "decline") {
    await fetchAgentJson(endpoint, token, agentPath("/approval"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }) });
}

export async function interruptCodexTurn(endpoint: string, token: string, threadId?: string) {
    await fetchAgentJson(endpoint, token, agentPath("/interrupt"), jsonPost({ threadId }));
}

export async function acknowledgeCodexHistory(endpoint: string, token: string, threadId: string, turnIds: string[]) {
    await fetchAgentJson(endpoint, token, agentPath("/history/ack"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, turnIds }) });
}

export async function revealAgentLocalFile(endpoint: string, token: string, path: string) {
    await fetchAgentJson(endpoint, token, "/agent/local-file/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export function resolveAgentMessageAssetUrl(endpoint: string, token: string, value: string) {
    const match = AGENT_MESSAGE_ASSET_PATTERN.exec(value);
    if (!match) return value.startsWith("agent-asset:") ? "" : value;
    const baseUrl = endpoint.trim().replace(/\/$/, "");
    return baseUrl && token ? `${baseUrl}/agent/message-assets/${match[1]}/${match[2]}?token=${encodeURIComponent(token)}` : "";
}

export function fetchCodexSkills(endpoint: string, token: string, forceReload = false) {
    return fetchAgentJson<AgentSkillsResponse>(endpoint, token, agentPath(`/skills${forceReload ? "?forceReload=1" : ""}`));
}

export function fetchCodexSkill(endpoint: string, token: string, name: string) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, agentPath(`/skills/${encodeURIComponent(name)}`));
}

export function createCodexSkill(endpoint: string, token: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, agentPath("/skills"), jsonPost(input));
}

export function createCodexSkillDraft(endpoint: string, token: string, input: AgentSkillDraftInput) {
    return fetchAgentJson<AgentSkillDraftResponse>(endpoint, token, agentPath("/skills/draft"), jsonPost(input));
}

export function updateCodexSkill(endpoint: string, token: string, name: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, agentPath(`/skills/${encodeURIComponent(name)}`), jsonPost(input));
}

export function deleteCodexSkill(endpoint: string, token: string, name: string, expectedRevision: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, agentPath(`/skills/${encodeURIComponent(name)}/delete`), jsonPost({ expectedRevision }));
}

export function setCodexSkillEnabled(endpoint: string, token: string, skill: Pick<AgentSkillSummary, "name" | "path">, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, agentPath(`/skills/${encodeURIComponent(skill.name)}/enabled`), jsonPost({ ...skill, enabled }));
}

/** 按当前选择的本地运行时（Codex / Claude）拼接 Agent 接口路径。 */
export function agentPath(path: string) {
    return `/agent/${useAgentStore.getState().runtime}${path}`;
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new AgentApiError(res.status, data);
    return data;
}

export type AgentConnectionDiagnosis =
    | { status: "ok"; protocolVersion?: number }
    | { status: "unreachable"; detail?: string }
    | { status: "outdated"; protocolVersion?: number }
    | { status: "invalid_token"; protocolVersion?: number }
    | { status: "origin_rejected"; protocolVersion?: number; detail?: string };

/** 在建立 SSE 前依次探测 /health 与 /auth/check，区分服务未启动、版本过旧、Token 错误与来源被拒。 */
export async function diagnoseAgentConnection(
    endpoint: string,
    token: string,
    expectedProtocolVersion: number,
    options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AgentConnectionDiagnosis> {
    const base = endpoint.trim().replace(/\/$/, "");
    const doFetch = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 2500;
    const timedFetch = async (url: string) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await doFetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    };

    let healthVersion: number | undefined;
    try {
        const healthRes = await timedFetch(`${base}/health`);
        if (!healthRes.ok) return { status: "unreachable", detail: `HTTP ${healthRes.status}` };
        const health = (await healthRes.json().catch(() => null)) as { ok?: boolean; protocolVersion?: number } | null;
        if (!health?.ok) return { status: "unreachable" };
        healthVersion = typeof health.protocolVersion === "number" ? health.protocolVersion : undefined;
        if (healthVersion !== undefined && healthVersion < expectedProtocolVersion) {
            return { status: "outdated", protocolVersion: healthVersion };
        }
    } catch (error) {
        return { status: "unreachable", detail: error instanceof Error ? error.message : String(error || "") };
    }

    try {
        const authRes = await timedFetch(`${base}/auth/check?token=${encodeURIComponent(token)}`);
        if (authRes.status === 401) return { status: "invalid_token", protocolVersion: healthVersion };
        if (authRes.status === 403) return { status: "origin_rejected", protocolVersion: healthVersion };
        if (authRes.ok || authRes.status === 404) return { status: "ok", protocolVersion: healthVersion };
        return { status: "unreachable", detail: `HTTP ${authRes.status}` };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return { status: "unreachable", detail: error.message };
        }
        return {
            status: "origin_rejected",
            protocolVersion: healthVersion,
            detail: error instanceof Error ? error.message : String(error || ""),
        };
    }
}

export async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${endpoint}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

type AgentWorkspaceResponse = { ok?: boolean; workspace?: { workspacePath: string; activeThreadId?: string }; conversation?: AgentConversationState };
export function resetAgentThread(endpoint: string, token: string, clientId: string, permissionMode: AgentPermissionMode) {
    return fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, agentPath("/threads/reset"), jsonPost({ clientId, permissionMode }));
}

function jsonPost(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
