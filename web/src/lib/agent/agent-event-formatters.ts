/**
 * 本地 Agent 推送事件的线程归属判定（纯函数，便于单独测试）。
 * 事件缺少线程字段时向后兼容放行，兼容尚未发送 threadId/turnId 的老版本服务端；
 * 一旦事件带线程归属，就不允许在另一个对话里执行。
 */
export function isCurrentThreadEvent(event: { threadId?: string; turnId?: string; thread_id?: string; turn_id?: string }, current: { threadId?: string; turnId?: string }): boolean {
    const threadId = event.threadId || event.thread_id || "";
    if (threadId && threadId !== (current.threadId || "")) return false;
    const turnId = event.turnId || event.turn_id || "";
    if (turnId && current.turnId && turnId !== current.turnId) return false;
    return true;
}
