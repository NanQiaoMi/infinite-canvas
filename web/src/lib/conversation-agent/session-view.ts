import type { AgentSession } from "@/lib/conversation-agent/types";

/** 会话切换时需要统一清理的跨会话残留字段；页面按字段执行，避免 A 会话的输入/参考图/产物流入 B 会话。 */
export type SessionSwitchReset = {
    composer: boolean;
    pageContext: boolean;
    references: boolean;
    mailboxes: boolean;
    artifact: boolean;
};

/** 命令面板与对话页会话视图只认 chat 会话，画布会话永远不进入。 */
export function selectChatSessions(sessions: AgentSession[]): AgentSession[] {
    return sessions.filter((session) => session.scope !== "canvas");
}

/**
 * 严格按 activeSessionId 命中会话：只允许非画布会话，且禁止用其它会话兜底。
 * 未命中时返回 null，由页面显示空态并在发送时新建会话，避免静默切换后带着另一个会话的历史继续对话。
 */
export function selectActiveChatSession(sessions: AgentSession[], activeSessionId: string | null | undefined): AgentSession | null {
    if (!activeSessionId) return null;
    const session = sessions.find((item) => item.id === activeSessionId);
    if (!session || session.scope === "canvas") return null;
    return session;
}

/**
 * 会话切换清理判定：首屏/首次挂载（previousSessionId 为空）不清理，避免吞掉从工作台带入的启动上下文；
 * 会话 id 未变化不清理；其余情况返回需要清理的字段清单。
 */
export function sessionSwitchResetPlan(previousSessionId: string | null | undefined, nextSessionId: string | null | undefined): SessionSwitchReset | null {
    if (!previousSessionId || previousSessionId === nextSessionId) return null;
    return { composer: true, pageContext: true, references: true, mailboxes: true, artifact: true };
}

/**
 * 重复提交守卫：只看目标会话自己的运行态切片，不看全局 running。
 * 全局 running 会被其它会话/画布面板的运行态覆盖，不能作为本会话是否在生成的依据。
 */
export function isSessionRunning(sessionRuns: Record<string, { running?: boolean } | undefined>, sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return Boolean(sessionRuns[sessionId]?.running);
}

/**
 * 从生图/视频工作台带入的草稿提示词只服务启动后的首轮：返回本轮注入值并提示页面清空，
 * 避免它常驻系统提示词，在后续轮次或其它会话继续影响模型。
 */
export function consumeLaunchPageContext(pageContext: string | undefined): { pageContext: string | undefined; clear: boolean } {
    const value = pageContext?.trim();
    return value ? { pageContext: value, clear: true } : { pageContext: undefined, clear: false };
}
