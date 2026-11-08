import type { AgentSession } from "./types";

export type SessionScope = "chat" | "canvas";

/** 已显式写入的 scope 具有最终权威；只允许 chat/canvas，其余值视为 legacy 交给启发式判断。 */
export function explicitSessionScope(value: unknown): SessionScope | null {
    return value === "chat" || value === "canvas" ? value : null;
}

/** 仅用于无 scope 字段的 legacy 记录：标题或消息里出现画布语义才推断为画布会话。 */
export function inferLegacyCanvasScope(record: Record<string, unknown>): boolean {
    if (record.canvasProjectId) return true;
    const title = String(record.title || "");
    if (/在画布|画布|画板/i.test(title)) return true;
    const messages = Array.isArray(record.messages) ? record.messages : [];
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const item = message as Record<string, unknown>;
        const call = item.call as Record<string, unknown> | undefined;
        if (call && typeof call === "object" && typeof call.tool === "string" && call.tool.startsWith("canvas_")) return true;
        if (item.role === "user" && /^在画布上/i.test(String(item.text || ""))) return true;
    }
    return false;
}

/** 持久化恢复时的 scope 判定：已有显式 scope 不得改判，只对 legacy 记录做一次性启发式推断。 */
export function resolvePersistedScope(record: Record<string, unknown>): SessionScope {
    return explicitSessionScope(record.scope) ?? (inferLegacyCanvasScope(record) ? "canvas" : "chat");
}

/** 画布面板会话选择：只认当前 projectId 绑定的 canvas 会话；无匹配返回 null，不回退到其它项目/无主会话。 */
export function selectCanvasSession(sessions: AgentSession[], projectId: string | null | undefined): AgentSession | null {
    if (!projectId) return null;
    return sessions.find((session) => session.scope === "canvas" && session.canvasProjectId === projectId) ?? null;
}

/** 画布工具执行/重试前的归属校验：两边都必须有明确 projectId 且完全一致。 */
export function matchesCanvasProject(expected: string | null | undefined, current: string | null | undefined): boolean {
    return Boolean(expected) && Boolean(current) && expected === current;
}

/** hydrate 恢复全局选中会话：只接受仍然存在且非画布的会话；失效直接返回 null，不静默改选其它会话。 */
export function selectHydratedSessionId(sessions: AgentSession[], savedActiveSessionId: string | null | undefined): string | null {
    if (!savedActiveSessionId) return null;
    const session = sessions.find((item) => item.id === savedActiveSessionId);
    return session && session.scope !== "canvas" ? session.id : null;
}
