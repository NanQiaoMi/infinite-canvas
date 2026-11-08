import { beforeEach, describe, expect, test } from "bun:test";
import localforage from "localforage";

import { explicitSessionScope, matchesCanvasProject, resolvePersistedScope, selectCanvasSession, selectHydratedSessionId } from "@/lib/conversation-agent/session-select";
import type { AgentSession } from "@/lib/conversation-agent/types";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";

// 与 store 共用 hooks.mjs 解析到的同一个 localforage 内存桩，用来注入 hydrate 的持久化 payload。
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "agent_conversations" });

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function session(overrides: Partial<AgentSession> & Pick<AgentSession, "id">): AgentSession {
    return {
        title: "",
        messages: [{ id: `${overrides.id}-u1`, role: "user" as const, text: "消息", createdAt: 1 }],
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

const chatSession = session({ id: "chat-a", scope: "chat", title: "普通会话" });
const canvasA = session({ id: "canvas-A", scope: "canvas", canvasProjectId: "proj-A", title: "项目A会话" });
const canvasB = session({ id: "canvas-B", scope: "canvas", canvasProjectId: "proj-B", title: "项目B会话" });
const unownedCanvas = session({ id: "canvas-unowned", scope: "canvas", title: "无主画布会话" });

function resetStore() {
    useConversationAgentStore.setState({
        hydrated: false,
        sessions: [],
        activeSessionId: null,
        sessionRuns: {},
        streamingText: "",
        running: false,
        runningTool: null,
        launchContext: null,
        artifact: null,
        pendingReference: null,
        pendingReferences: [],
        composerDraft: null,
    });
}

async function seedPersisted(payload: unknown) {
    // 等待上一个用例可能遗留的 400ms 持久化定时器先落盘，避免覆盖本次注入的 payload
    await wait(450);
    await storage.removeItem("state");
    await storage.setItem("state", payload);
}

beforeEach(async () => {
    resetStore();
    await storage.removeItem("state");
});

describe("画布会话选择：严格按 projectId，删除跨项目回退", () => {
    test("无匹配项目的会话时返回 null，不再回退 canvasSessions[0]", () => {
        const sessions = [canvasA, canvasB, unownedCanvas];
        // 修复前：proj-C 没有自己的会话 → 回退到 canvasSessions[0]（项目 A 的会话）
        expect(selectCanvasSession(sessions, "proj-C")).toBeNull();
        expect(selectCanvasSession(sessions, "proj-A")?.id).toBe("canvas-A");
        expect(selectCanvasSession(sessions, "proj-B")?.id).toBe("canvas-B");
    });

    test("projectId 缺失时不选中任何画布会话（不渲染/不送入其它项目历史）", () => {
        expect(selectCanvasSession([canvasA, unownedCanvas], undefined)).toBeNull();
        expect(selectCanvasSession([canvasA, unownedCanvas], null)).toBeNull();
        expect(selectCanvasSession([canvasA, unownedCanvas], "")).toBeNull();
    });

    test("无 canvasProjectId 的无主画布会话永远不会被任何项目选中", () => {
        expect(selectCanvasSession([unownedCanvas], "proj-A")).toBeNull();
        expect(selectCanvasSession([unownedCanvas], "proj-B")).toBeNull();
        expect(selectCanvasSession([unownedCanvas, canvasA], "proj-A")?.id).toBe("canvas-A");
    });

    test("chat 会话即使标题/内容涉及画布也不会被画布面板选中", () => {
        const misleadingChat = session({ id: "chat-canvas-topic", scope: "chat", title: "画布助手怎么用" });
        expect(selectCanvasSession([misleadingChat], "proj-A")).toBeNull();
    });
});

describe("hydrate：显式 scope 不得改判、失效 activeSessionId 回退 null", () => {
    test("纯函数：显式 chat/canvas 优先，只有无 scope 的 legacy 记录才做启发式推断", () => {
        expect(explicitSessionScope("chat")).toBe("chat");
        expect(explicitSessionScope("canvas")).toBe("canvas");
        expect(explicitSessionScope(undefined)).toBeNull();
        expect(explicitSessionScope("unknown")).toBeNull();
        // 显式 chat：标题与消息都命中画布语义也不得改判
        expect(resolvePersistedScope({ scope: "chat", title: "画布助手怎么用", messages: [{ role: "user", text: "在画布上画猫" }] })).toBe("chat");
        expect(resolvePersistedScope({ scope: "canvas", title: "普通标题" })).toBe("canvas");
        // 无 scope 的 legacy 记录：按启发式推断
        expect(resolvePersistedScope({ title: "画布布局建议" })).toBe("canvas");
        expect(resolvePersistedScope({ messages: [{ id: "t1", role: "tool", call: { tool: "canvas_get_context", arguments: {} } }] })).toBe("canvas");
        expect(resolvePersistedScope({ title: "写一段文案" })).toBe("chat");
    });

    test("纯函数：activeSessionId 失效/指向画布会话时返回 null，不改选其它会话", () => {
        const sessions = [chatSession, canvasA];
        expect(selectHydratedSessionId(sessions, "chat-a")).toBe("chat-a");
        expect(selectHydratedSessionId(sessions, "canvas-A")).toBeNull();
        expect(selectHydratedSessionId(sessions, "missing-session")).toBeNull();
        expect(selectHydratedSessionId(sessions, null)).toBeNull();
    });

    test("真实 hydrate：显式 chat 记录不被改判为 canvas，legacy 记录可推断", async () => {
        await seedPersisted({
            activeSessionId: "chat-explicit",
            sessions: [
                // 显式 chat，标题和首条消息都含“画布”→ 修复前会被改判为 canvas 并从对话页消失
                { id: "chat-explicit", scope: "chat", title: "在画布上生成猫咪海报", messages: [{ id: "u1", role: "user", text: "在画布上帮我生成一张猫咪海报", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
                // 显式 canvas，必须保持 canvas
                { id: "canvas-explicit", scope: "canvas", canvasProjectId: "proj-A", title: "项目A", messages: [{ id: "u2", role: "user", text: "生成图标", createdAt: 2 }], createdAt: 2, updatedAt: 2 },
                // legacy（无 scope）画布语义记录 → 推断为 canvas
                { id: "legacy-canvas", title: "在画布上生成猫咪海报", messages: [{ id: "u3", role: "user", text: "在画布上生成猫咪海报", createdAt: 3 }], createdAt: 3, updatedAt: 3 },
                // legacy（无 scope）普通记录 → chat
                { id: "legacy-chat", title: "写一段文案", messages: [{ id: "u4", role: "user", text: "写一段文案", createdAt: 4 }], createdAt: 4, updatedAt: 4 },
            ],
        });

        await useConversationAgentStore.getState().hydrate();
        const state = useConversationAgentStore.getState();
        const byId = new Map(state.sessions.map((item) => [item.id, item]));
        expect(byId.get("chat-explicit")?.scope).toBe("chat");
        expect(byId.get("canvas-explicit")?.scope).toBe("canvas");
        expect(byId.get("canvas-explicit")?.canvasProjectId).toBe("proj-A");
        expect(byId.get("legacy-canvas")?.scope).toBe("canvas");
        expect(byId.get("legacy-chat")?.scope).toBe("chat");
        expect(state.activeSessionId).toBe("chat-explicit");
    });

    test("真实 hydrate：失效 activeSessionId 回退 null，不静默改选另一个会话", async () => {
        await seedPersisted({
            activeSessionId: "deleted-session",
            sessions: [
                { id: "chat-a", scope: "chat", title: "会话A", messages: [{ id: "u1", role: "user", text: "hi", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
                { id: "canvas-A", scope: "canvas", canvasProjectId: "proj-A", title: "画布", messages: [{ id: "u2", role: "user", text: "hi", createdAt: 2 }], createdAt: 2, updatedAt: 2 },
            ],
        });

        await useConversationAgentStore.getState().hydrate();
        // 修复前会静默回退到 sessions[0]（可能是画布会话或被改判的 chat 会话）
        expect(useConversationAgentStore.getState().activeSessionId).toBeNull();
    });

    test("真实 hydrate：已保存的 activeSessionId 指向画布会话时不作为全局选中会话", async () => {
        await seedPersisted({
            activeSessionId: "canvas-A",
            sessions: [
                { id: "canvas-A", scope: "canvas", canvasProjectId: "proj-A", title: "画布", messages: [{ id: "u1", role: "user", text: "hi", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
                { id: "chat-a", scope: "chat", title: "会话A", messages: [{ id: "u2", role: "user", text: "hi", createdAt: 2 }], createdAt: 2, updatedAt: 2 },
            ],
        });

        await useConversationAgentStore.getState().hydrate();
        expect(useConversationAgentStore.getState().activeSessionId).toBeNull();
    });
});

describe("createSession：拒绝无主会话，画布“新对话”强制新建", () => {
    test("projectId 缺失时拒绝创建画布会话（不产生无主会话）", () => {
        const before = useConversationAgentStore.getState().sessions.length;
        const created = useConversationAgentStore.getState().createSession({ scope: "canvas" });
        expect(created).toBeNull();
        const state = useConversationAgentStore.getState();
        expect(state.sessions.length).toBe(before);
        expect(state.sessions.some((item) => item.scope === "canvas" && !item.canvasProjectId)).toBe(false);
    });

    test("画布会话创建时强制写入 canvasProjectId 与 canvas scope", () => {
        const id = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" });
        const created = useConversationAgentStore.getState().sessions.find((item) => item.id === id);
        expect(created?.scope).toBe("canvas");
        expect(created?.canvasProjectId).toBe("proj-A");
    });

    test("forceNew 强制新建会话：同一项目第二次创建返回新 id，旧会话不再被选中", () => {
        const idA = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" });
        useConversationAgentStore.getState().appendMessages(idA as string, [{ id: "a-u1", role: "user", text: "旧会话内容", createdAt: 1 }]);
        // 不带 forceNew 仍复用当前项目会话（send 路径依赖）
        const reused = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" });
        expect(reused).toBe(idA);
        // 画布“新对话”必须 forceNew，否则旧上下文继续生效
        const forced = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A", forceNew: true });
        expect(forced).not.toBe(idA);
        const state = useConversationAgentStore.getState();
        expect(selectCanvasSession(state.sessions, "proj-A")?.id).toBe(forced);
        expect(state.sessions.find((item) => item.id === forced)?.messages.length).toBe(0);
    });

    test("不同项目各自持有会话，互不复用", () => {
        const idA = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" });
        const idB = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-B" });
        expect(idA).not.toBe(idB);
        const state = useConversationAgentStore.getState();
        expect(selectCanvasSession(state.sessions, "proj-A")?.id).toBe(idA);
        expect(selectCanvasSession(state.sessions, "proj-B")?.id).toBe(idB);
    });
});

describe("运行态按会话归属（画布面板不再读写全局 running/streamingText/runningTool）", () => {
    test("两个画布会话的运行态互不串台，且不写入全局运行态", () => {
        const idA = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" }) as string;
        const idB = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-B" }) as string;
        useConversationAgentStore.getState().setSessionRun(idA, { running: true, streamingText: "A 的流式文字" });
        useConversationAgentStore.getState().setSessionRun(idB, { running: true, streamingText: "B 的流式文字" });

        const state = useConversationAgentStore.getState();
        expect(state.sessionRuns[idA]?.running).toBe(true);
        expect(state.sessionRuns[idA]?.streamingText).toBe("A 的流式文字");
        expect(state.sessionRuns[idB]?.streamingText).toBe("B 的流式文字");
        // 画布会话从不作为全局 activeSession，全局运行态不应被画布轮次污染（chat 页/画布面板互不阻塞）
        expect(state.running).toBe(false);
        expect(state.streamingText).toBe("");
        expect(state.runningTool).toBeNull();
    });

    test("clearSessionRun 只清理本会话，其它会话运行态保留", () => {
        const idA = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" }) as string;
        const idB = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-B" }) as string;
        useConversationAgentStore.getState().setSessionRun(idA, { running: true, streamingText: "A 未完成" });
        useConversationAgentStore.getState().setSessionRun(idB, { running: true, streamingText: "B 未完成" });

        useConversationAgentStore.getState().clearSessionRun(idA);

        const state = useConversationAgentStore.getState();
        expect(state.sessionRuns[idA]).toBeUndefined();
        expect(state.sessionRuns[idB]?.running).toBe(true);
        expect(state.sessionRuns[idB]?.streamingText).toBe("B 未完成");
    });

    test("删除会话同时清理其运行态，不影响其它会话", () => {
        const idA = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" }) as string;
        const idB = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-B" }) as string;
        useConversationAgentStore.getState().setSessionRun(idA, { running: true, streamingText: "A" });
        useConversationAgentStore.getState().setSessionRun(idB, { running: true, streamingText: "B" });

        useConversationAgentStore.getState().deleteSession(idA);

        const state = useConversationAgentStore.getState();
        expect(state.sessionRuns[idA]).toBeUndefined();
        expect(state.sessionRuns[idB]?.running).toBe(true);
        expect(selectCanvasSession(state.sessions, "proj-A")).toBeNull();
    });
});

describe("运行中切换画布项目：工具执行归属校验", () => {
    test("matchesCanvasProject 只在两边项目一致时通过", () => {
        expect(matchesCanvasProject("proj-A", "proj-A")).toBe(true);
        expect(matchesCanvasProject("proj-A", "proj-B")).toBe(false);
        expect(matchesCanvasProject("proj-A", undefined)).toBe(false);
        expect(matchesCanvasProject(undefined, "proj-A")).toBe(false);
        expect(matchesCanvasProject(undefined, undefined)).toBe(false);
        expect(matchesCanvasProject(null, null)).toBe(false);
        expect(matchesCanvasProject("", "")).toBe(false);
    });

    test("A 轮次运行中切到 B：面板选择为空、旧轮次工具归属校验失败（不落节点/不触发生成）", () => {
        const idA = useConversationAgentStore.getState().createSession({ scope: "canvas", canvasProjectId: "proj-A" }) as string;
        useConversationAgentStore.getState().appendMessages(idA, [{ id: "a-u1", role: "user", text: "在画布上生成一张图", createdAt: 1 }]);
        useConversationAgentStore.getState().setSessionRun(idA, { running: true, streamingText: "" });

        // 切到 proj-B：B 没有自己的会话 → 空态，绝不渲染/送入 A 的历史
        const afterSwitch = useConversationAgentStore.getState();
        expect(selectCanvasSession(afterSwitch.sessions, "proj-B")).toBeNull();
        // A 轮次的工具归属 proj-A 与当前画布 proj-B 不一致 → 必须执行失败
        expect(matchesCanvasProject("proj-A", "proj-B")).toBe(false);
        // 切回 proj-A 仍能看到 A 自己的会话，仅归属一致的轮次可继续
        expect(selectCanvasSession(useConversationAgentStore.getState().sessions, "proj-A")?.id).toBe(idA);
        expect(matchesCanvasProject("proj-A", "proj-A")).toBe(true);
    });

    test("旧会话 tool 卡片重试仅在会话归属与当前项目一致时可用", () => {
        // 复刻画布面板 retryEnabled = Boolean(activeSession) && matchesCanvasProject(activeSession.canvasProjectId, projectId)
        const retryEnabledFor = (sessions: AgentSession[], projectId: string | undefined) => {
            const active = selectCanvasSession(sessions, projectId);
            return Boolean(active) && matchesCanvasProject(active?.canvasProjectId, projectId);
        };
        const sessions = [canvasA, canvasB];
        expect(retryEnabledFor(sessions, "proj-A")).toBe(true);
        expect(retryEnabledFor(sessions, "proj-B")).toBe(true);
        expect(retryEnabledFor(sessions, "proj-C")).toBe(false);
        expect(retryEnabledFor([unownedCanvas], "proj-A")).toBe(false);
        expect(retryEnabledFor([], "proj-A")).toBe(false);
    });
});
