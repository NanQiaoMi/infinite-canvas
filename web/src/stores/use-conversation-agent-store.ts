import localforage from "localforage";
import { nanoid } from "nanoid";
import { create } from "zustand";

import type { AgentImageRef, AgentLaunchContext, AgentMessage, AgentSession, AgentStep, AgentToolCall, AgentToolResult } from "@/lib/conversation-agent/types";
import type { AgentIntent } from "@/lib/conversation-agent/intent";
import { resolvePersistedScope, selectHydratedSessionId, type SessionScope } from "@/lib/conversation-agent/session-select";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "agent_conversations" });
const MAX_SESSIONS = 50;
const MAX_MESSAGES = 200;
const PERSIST_DELAY_MS = 400;

type PersistedState = { sessions: AgentSession[]; activeSessionId: string | null };

type CreateSessionOptions = { scope?: SessionScope; canvasProjectId?: string; forceNew?: boolean };

/**
 * createSession 的重载：
 * - 默认/chat：始终返回会话 id；
 * - canvas：必须绑定 canvasProjectId，拒绝创建时返回 null（调用方负责提示）。
 */
type CreateSession = {
    (options?: { scope?: "chat"; canvasProjectId?: string; forceNew?: boolean }): string;
    (options: { scope: "canvas"; canvasProjectId?: string; forceNew?: boolean }): string | null;
};

export type SessionRunState = {
    running: boolean;
    streamingText: string;
    runningTool: AgentToolCall | null;
    steps: AgentStep[];
    completedToolResults: Array<{ id: string; call: AgentToolCall; result: AgentToolResult }>;
    turnStartedAt: number;
    intent: AgentIntent | null;
    turnId: string | null;
};

type ConversationAgentStore = {
    hydrated: boolean;
    sessions: AgentSession[];
    activeSessionId: string | null;
    sessionRuns: Record<string, SessionRunState>;
    streamingText: string;
    running: boolean;
    runningTool: AgentToolCall | null;
    launchContext: AgentLaunchContext | null;
    artifact: AgentImageRef | null;
    pendingReference: AgentImageRef | null;
    pendingReferences: AgentImageRef[];
    composerDraft: string | null;
    hydrate: () => Promise<void>;
    openArtifact: (image: AgentImageRef) => void;
    closeArtifact: () => void;
    requestReference: (image: AgentImageRef) => void;
    requestReferences: (images: AgentImageRef[]) => void;
    consumeReference: () => AgentImageRef | null;
    consumeReferences: () => AgentImageRef[];
    setComposerDraft: (text: string) => void;
    consumeComposerDraft: () => string | null;
    createSession: CreateSession;
    deleteSession: (id: string) => void;
    renameSession: (id: string, title: string) => void;
    setActiveSession: (id: string) => void;
    appendMessages: (sessionId: string, messages: AgentMessage[]) => void;
    setSessionRun: (sessionId: string, updater: Partial<SessionRunState> | ((prev: SessionRunState) => SessionRunState)) => void;
    clearSessionRun: (sessionId: string) => void;
    setStreamingText: (text: string) => void;
    setRunning: (running: boolean) => void;
    setRunningTool: (call: AgentToolCall | null) => void;
    setLaunchContext: (context: AgentLaunchContext | null) => void;
    clearAll: () => void;
};

export function formatSessionTitle(text: string): string {
    const cleaned = text
        .replace(/^\/(prompt|image|edit|model)\s+/, "")
        .replace(/^在画布(?:上|中)?(?:批量)?(?:创建|生成|排布|制作)?/i, "")
        .replace(/^(?:帮我|请帮我|请|给我)?(?:生成|画一张|画一个|制作)?(?:png)?(?:透明底|透明图片|透明背景)?(?:图片|图像)?[:：]?/i, "")
        .trim();
    const target = cleaned || text.trim();
    if (!target) return "";
    if (target.length <= 18) return target;
    return `${target.slice(0, 18)}...`;
}

function createSessionRecord(options?: { scope?: "chat" | "canvas"; canvasProjectId?: string }): AgentSession {
    const now = Date.now();
    return {
        id: nanoid(),
        title: "",
        messages: [],
        createdAt: now,
        updatedAt: now,
        scope: options?.scope || "chat",
        ...(options?.canvasProjectId ? { canvasProjectId: options.canvasProjectId } : {}),
    };
}

function sanitizeMessages(value: unknown): AgentMessage[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is AgentMessage => {
        if (!item || typeof item !== "object") return false;
        const record = item as Record<string, unknown>;
        return typeof record.id === "string" && ["user", "assistant", "tool", "error"].includes(String(record.role));
    });
}

function sanitizeSessions(value: unknown): AgentSession[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => {
            const scope = resolvePersistedScope(item);
            return {
                id: String(item.id || nanoid()),
                title: String(item.title || ""),
                scope,
                ...(scope === "canvas" && item.canvasProjectId ? { canvasProjectId: String(item.canvasProjectId) } : {}),
                messages: sanitizeMessages(item.messages).map((message) => (message.role === "assistant" ? { ...message, promptBlocks: Array.isArray(message.promptBlocks) ? message.promptBlocks : [] } : message)),
                createdAt: Number(item.createdAt) || Date.now(),
                updatedAt: Number(item.updatedAt) || Date.now(),
            };
        })
        .slice(0, MAX_SESSIONS);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;

export const useConversationAgentStore = create<ConversationAgentStore>()((set, get) => {
    const schedulePersist = () => {
        persistSeq += 1;
        const seq = persistSeq;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            if (seq !== persistSeq) return;
            const state = get();
            const payload: PersistedState = { sessions: state.sessions, activeSessionId: state.activeSessionId };
            void storage.setItem("state", payload).catch(() => undefined);
        }, PERSIST_DELAY_MS);
    };
    return {
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
        openArtifact: (image) => set({ artifact: image }),
        closeArtifact: () => set({ artifact: null }),
        requestReference: (image) => set((state) => ({ pendingReference: image, pendingReferences: [...state.pendingReferences, image] })),
        requestReferences: (images) => set((state) => ({ pendingReferences: [...state.pendingReferences, ...images], pendingReference: images[0] ?? state.pendingReference })),
        consumeReference: () => {
            const reference = get().pendingReference;
            if (reference) set({ pendingReference: null });
            return reference;
        },
        consumeReferences: () => {
            const list = get().pendingReferences;
            if (list.length) set({ pendingReferences: [], pendingReference: null });
            return list;
        },
        setComposerDraft: (text) => set({ composerDraft: text }),
        consumeComposerDraft: () => {
            const draft = get().composerDraft;
            if (draft !== null) set({ composerDraft: null });
            return draft;
        },
        hydrate: async () => {
            if (get().hydrated) return;
            try {
                const saved = await storage.getItem<PersistedState>("state");
                const rawSessions = sanitizeSessions(saved?.sessions);
                // 过滤掉既无内容也非当前唯一的幽灵空会话
                const sessions = rawSessions.filter((s, idx) => s.messages.length > 0 || idx === 0);
                // 失效的 activeSessionId 直接回到空态，不静默改选其它会话（画布会话也不作为全局选中会话）
                const activeId = selectHydratedSessionId(sessions, saved?.activeSessionId);
                set({ sessions, activeSessionId: activeId, hydrated: true });
            } catch {
                set({ hydrated: true });
            }
        },
        createSession: ((options?: CreateSessionOptions): string | null => {
            const scope = options?.scope || "chat";
            const canvasProjectId = options?.canvasProjectId;
            const forceNew = options?.forceNew === true;
            // 画布会话必须绑定画布项目：projectId 缺失时拒绝创建，避免出现被所有项目共用的无主会话
            if (scope === "canvas" && !canvasProjectId) return null;
            if (!forceNew) {
                if (scope === "canvas") {
                    const existing = get().sessions.find((s) => s.scope === "canvas" && s.canvasProjectId === canvasProjectId);
                    if (existing) {
                        set({ streamingText: "", runningTool: null });
                        return existing.id;
                    }
                } else {
                    const currentActive = get().sessions.find((s) => s.id === get().activeSessionId && s.scope !== "canvas");
                    if (currentActive && currentActive.messages.length === 0) {
                        return currentActive.id;
                    }
                }
            }
            const session = createSessionRecord({ scope, canvasProjectId });
            set((state) => ({
                sessions: [session, ...state.sessions].slice(0, MAX_SESSIONS),
                activeSessionId: scope === "chat" ? session.id : state.activeSessionId,
                streamingText: "",
                runningTool: null,
            }));
            schedulePersist();
            return session.id;
        }) as CreateSession,
        deleteSession: (id) => {
            set((state) => {
                const sessions = state.sessions.filter((session) => session.id !== id);
                const nextRuns = { ...state.sessionRuns };
                delete nextRuns[id];
                // 删除当前会话后回到空态，不静默切换到其它会话（其它会话可能是无主/其它项目的画布会话）
                if (state.activeSessionId === id) {
                    return { sessions, activeSessionId: null, sessionRuns: nextRuns, streamingText: "", runningTool: null, running: false };
                }
                return { sessions, sessionRuns: nextRuns };
            });
            schedulePersist();
        },
        renameSession: (id, title) => {
            const nextTitle = title.trim().slice(0, 40);
            if (!nextTitle) return;
            set((state) => ({ sessions: state.sessions.map((session) => (session.id === id ? { ...session, title: nextTitle, updatedAt: Date.now() } : session)) }));
            schedulePersist();
        },
        setActiveSession: (id) => {
            if (!get().sessions.some((session) => session.id === id)) return;
            const targetRun = get().sessionRuns[id];
            set({
                activeSessionId: id,
                streamingText: targetRun?.streamingText ?? "",
                runningTool: targetRun?.runningTool ?? null,
                running: targetRun?.running ?? false,
            });
            schedulePersist();
        },
        appendMessages: (sessionId, messages) => {
            if (!messages.length) return;
            set((state) => ({
                sessions: state.sessions.map((session) => {
                    if (session.id !== sessionId) return session;
                    const existing = new Set(session.messages.map((message) => message.id));
                    const tagged = messages.map((m) => ({
                        ...m,
                        threadId: m.threadId || sessionId,
                        itemId: m.itemId || m.id,
                    }));
                    const merged = [...session.messages, ...tagged.filter((message) => !existing.has(message.id))].slice(-MAX_MESSAGES);
                    const userMsg = merged.find((message) => message.role === "user");
                    const title = session.title || (userMsg?.text ? formatSessionTitle(userMsg.text) : "");
                    return { ...session, messages: merged, title, updatedAt: Date.now() };
                }),
            }));
            schedulePersist();
        },
        setSessionRun: (sessionId, updater) => {
            set((state) => {
                const current = state.sessionRuns[sessionId] || {
                    running: false,
                    streamingText: "",
                    runningTool: null,
                    steps: [],
                    completedToolResults: [],
                    turnStartedAt: 0,
                    intent: null,
                    turnId: null,
                };
                const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
                const nextRuns = { ...state.sessionRuns, [sessionId]: next };
                const isActive = state.activeSessionId === sessionId;
                return {
                    sessionRuns: nextRuns,
                    ...(isActive
                        ? {
                              running: next.running,
                              streamingText: next.streamingText,
                              runningTool: next.runningTool,
                          }
                        : {}),
                };
            });
        },
        clearSessionRun: (sessionId) => {
            set((state) => {
                const nextRuns = { ...state.sessionRuns };
                delete nextRuns[sessionId];
                const isActive = state.activeSessionId === sessionId;
                return {
                    sessionRuns: nextRuns,
                    ...(isActive
                        ? {
                              running: false,
                              streamingText: "",
                              runningTool: null,
                          }
                        : {}),
                };
            });
        },
        setStreamingText: (text) => set({ streamingText: text }),
        setRunning: (running) => set({ running, ...(running ? {} : { streamingText: "", runningTool: null }) }),
        setRunningTool: (call) => set({ runningTool: call }),
        setLaunchContext: (context) => set({ launchContext: context }),
        clearAll: () => {
            set({ sessions: [], activeSessionId: null, sessionRuns: {}, streamingText: "", running: false, runningTool: null });
            persistSeq += 1;
            void storage.removeItem("state").catch(() => undefined);
        },
    };
});
