/**
 * 本地 Agent 推送事件的线程归属判定（纯函数，便于单独测试）。
 * 与 UI 层严格版 isCurrentThreadEvent（components/agent/agent-event-formatters.ts）区分命名，避免同名歧义：
 * 本函数用于工具调用等事件的执行前校验，事件缺少线程字段时向后兼容放行，
 * 一旦事件带线程归属，就不允许在另一个对话里执行。
 */
export function isAgentThreadEvent(event: { threadId?: string; turnId?: string; thread_id?: string; turn_id?: string }, current: { threadId?: string; turnId?: string }): boolean {
    const threadId = event.threadId || event.thread_id || "";
    if (threadId && threadId !== (current.threadId || "")) return false;
    const turnId = event.turnId || event.turn_id || "";
    if (turnId && current.turnId && turnId !== current.turnId) return false;
    return true;
}
