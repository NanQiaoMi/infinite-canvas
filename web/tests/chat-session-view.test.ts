import { describe, expect, test } from "bun:test";

import { isCurrentThreadEvent } from "@/lib/agent/agent-event-formatters";
import { consumeLaunchPageContext, isSessionRunning, selectActiveChatSession, selectChatSessions, sessionSwitchResetPlan } from "@/lib/conversation-agent/session-view";
import type { AgentSession } from "@/lib/conversation-agent/types";

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
    return { id, title: id, messages: [], createdAt: 0, updatedAt: 0, scope: "chat", ...overrides };
}

describe("selectActiveChatSession：严格按 activeSessionId 命中，不做跨会话兜底", () => {
    const sessions = [session("chat-a"), session("chat-b"), session("canvas-a", { scope: "canvas", canvasProjectId: "project-1" })];

    test("命中 activeSessionId 对应的 chat 会话", () => {
        expect(selectActiveChatSession(sessions, "chat-b")?.id).toBe("chat-b");
    });

    test("activeSessionId 失效时返回空态，禁止回退到 chatSessions[0]", () => {
        expect(selectActiveChatSession(sessions, "missing-session")).toBeNull();
        expect(selectActiveChatSession(sessions, null)).toBeNull();
        expect(selectActiveChatSession(sessions, "")).toBeNull();
    });

    test("activeSessionId 指向画布会话时返回空态", () => {
        expect(selectActiveChatSession(sessions, "canvas-a")).toBeNull();
    });

    test("无 scope 的旧记录按 chat 会话处理", () => {
        const legacy = session("legacy");
        delete legacy.scope;
        expect(selectActiveChatSession([legacy], "legacy")?.id).toBe("legacy");
    });

    test("空会话列表返回 null", () => {
        expect(selectActiveChatSession([], "chat-a")).toBeNull();
    });
});

describe("selectChatSessions：只保留 chat 会话", () => {
    test("过滤画布会话，保持原有顺序", () => {
        const list = selectChatSessions([session("chat-a"), session("canvas-a", { scope: "canvas" }), session("chat-b"), session("canvas-b", { scope: "canvas", canvasProjectId: "p" })]);
        expect(list.map((item) => item.id)).toEqual(["chat-a", "chat-b"]);
    });

    test("命令面板选中任一可见会话后，页面严格选择必定命中同一会话", () => {
        const sessions = [session("chat-a"), session("canvas-a", { scope: "canvas" }), session("chat-b")];
        for (const item of selectChatSessions(sessions)) {
            expect(selectActiveChatSession(sessions, item.id)?.id).toBe(item.id);
        }
    });
});

describe("sessionSwitchResetPlan：切会话清理判定", () => {
    test("首次挂载/首次 hydrate 不清理，保留工作台带入的启动上下文", () => {
        expect(sessionSwitchResetPlan(undefined, "chat-a")).toBeNull();
        expect(sessionSwitchResetPlan(null, "chat-a")).toBeNull();
    });

    test("同一会话（如新增消息重渲染）不清理", () => {
        expect(sessionSwitchResetPlan("chat-a", "chat-a")).toBeNull();
    });

    test("A 会话切到 B 会话时清理全部跨会话残留", () => {
        expect(sessionSwitchResetPlan("chat-a", "chat-b")).toEqual({ composer: true, pageContext: true, references: true, mailboxes: true, artifact: true });
    });

    test("删除当前会话回到空态时同样清理", () => {
        expect(sessionSwitchResetPlan("chat-a", null)).toEqual({ composer: true, pageContext: true, references: true, mailboxes: true, artifact: true });
    });
});

describe("isSessionRunning：重复提交守卫只认本会话运行态", () => {
    test("目标会话在运行中时拦截", () => {
        expect(isSessionRunning({ "chat-a": { running: true } }, "chat-a")).toBe(true);
    });

    test("其它会话运行不影响本会话", () => {
        expect(isSessionRunning({ "chat-b": { running: true } }, "chat-a")).toBe(false);
    });

    test("没有会话 id 或没有运行态时不拦截", () => {
        expect(isSessionRunning({ "chat-a": { running: true } }, null)).toBe(false);
        expect(isSessionRunning({}, "chat-a")).toBe(false);
    });
});

describe("consumeLaunchPageContext：启动上下文只注入启动后的首轮", () => {
    test("没有启动上下文时不注入、不清空", () => {
        expect(consumeLaunchPageContext(undefined)).toEqual({ pageContext: undefined, clear: false });
        expect(consumeLaunchPageContext("   ")).toEqual({ pageContext: undefined, clear: false });
    });

    test("有启动上下文时注入本轮并提示清空，避免常驻 system prompt", () => {
        expect(consumeLaunchPageContext(" 霓虹赛博朋克猫咪头像 ")).toEqual({ pageContext: "霓虹赛博朋克猫咪头像", clear: true });
    });
});

describe("isCurrentThreadEvent：本地 Codex 事件线程归属", () => {
    const current = { threadId: "thread-1", turnId: "turn-1" };

    test("同线程同轮次事件放行", () => {
        expect(isCurrentThreadEvent({ threadId: "thread-1", turnId: "turn-1" }, current)).toBe(true);
    });

    test("非当前线程事件丢弃", () => {
        expect(isCurrentThreadEvent({ threadId: "thread-0", turnId: "turn-0" }, current)).toBe(false);
    });

    test("同线程但旧轮次事件丢弃", () => {
        expect(isCurrentThreadEvent({ threadId: "thread-1", turnId: "turn-0" }, current)).toBe(false);
    });

    test("事件缺少线程字段时向后兼容放行", () => {
        expect(isCurrentThreadEvent({}, current)).toBe(true);
        expect(isCurrentThreadEvent({ threadId: "", turnId: "" }, current)).toBe(true);
    });

    test("兼容 snake_case 字段", () => {
        expect(isCurrentThreadEvent({ thread_id: "thread-1", turn_id: "turn-1" }, current)).toBe(true);
        expect(isCurrentThreadEvent({ thread_id: "thread-0", turn_id: "turn-0" }, current)).toBe(false);
    });

    test("当前轮次未知时不因 turnId 丢弃（线程仍匹配）", () => {
        expect(isCurrentThreadEvent({ threadId: "thread-1", turnId: "turn-9" }, { threadId: "thread-1", turnId: "" })).toBe(true);
    });
});
