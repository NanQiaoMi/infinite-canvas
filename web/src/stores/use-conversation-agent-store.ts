import localforage from "localforage";
import { nanoid } from "nanoid";
import { create } from "zustand";

import type { AgentImageRef, AgentLaunchContext, AgentMessage, AgentSession, AgentToolCall } from "@/lib/conversation-agent/types";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "agent_conversations" });
const MAX_SESSIONS = 50;
const MAX_MESSAGES = 200;
const PERSIST_DELAY_MS = 400;

type PersistedState = { sessions: AgentSession[]; activeSessionId: string | null };

type ConversationAgentStore = {
    hydrated: boolean;
    sessions: AgentSession[];
    activeSessionId: string | null;
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
    createSession: (options?: { scope?: "chat" | "canvas"; canvasProjectId?: string }) => string;
    deleteSession: (id: string) => void;
    renameSession: (id: string, title: string) => void;
    setActiveSession: (id: string) => void;
    appendMessages: (sessionId: string, messages: AgentMessage[]) => void;
    setStreamingText: (text: string) => void;
    setRunning: (running: boolean) => void;
    setRunningTool: (call: AgentToolCall | null) => void;
    setLaunchContext: (context: AgentLaunchContext | null) => void;
    clearAll: () => void;
};

export function formatSessionTitle(text: string): string {
    const cleaned = text
        .replace(/^\/(prompt|image|edit|model)\s+/, "")
        .replace(/^在画布上(?:批量)?(?:生成|创建)?/i, "")
        .replace(/^(?:帮我|请帮我|请|给我)?(?:生成|画一张|画一个|制作)?(?:png)?(?:透明底|透明图片|透明背景)?[:：]?/i, "")
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

function isCanvasSessionHeuristic(item: Record<string, unknown>): boolean {
    if (item.scope === "canvas") return true;
    if (item.canvasProjectId) return true;
    const title = String(item.title || "");
    if (/在画布|画布|画板/i.test(title)) return true;
    const messages = Array.isArray(item.messages) ? item.messages : [];
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const record = msg as Record<string, unknown>;
        const call = record.call as Record<string, unknown> | undefined;
        if (call && typeof call === "object" && typeof call.tool === "string" && call.tool.startsWith("canvas_")) {
            return true;
        }
        if (record.role === "user") {
            const text = String(record.text || "");
            if (/^在画布上/i.test(text)) return true;
        }
    }
    return false;
}

function sanitizeSessions(value: unknown): AgentSession[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => {
            const isCanvas = isCanvasSessionHeuristic(item);
            return {
                id: String(item.id || nanoid()),
                title: String(item.title || ""),
                scope: isCanvas ? ("canvas" as const) : ("chat" as const),
                ...(item.canvasProjectId ? { canvasProjectId: String(item.canvasProjectId) } : {}),
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
                const activeId = saved?.activeSessionId && sessions.some((session) => session.id === saved.activeSessionId && session.scope !== "canvas")
                    ? saved.activeSessionId
                    : sessions.find((s) => s.scope !== "canvas")?.id ?? sessions[0]?.id ?? null;
                set({ sessions, activeSessionId: activeId, hydrated: true });
            } catch {
                set({ hydrated: true });
            }
        },
        createSession: (options?: { scope?: "chat" | "canvas"; canvasProjectId?: string }) => {
            const scope = options?.scope || "chat";
            const canvasProjectId = options?.canvasProjectId;
            if (scope === "canvas" && canvasProjectId) {
                const existing = get().sessions.find((s) => s.scope === "canvas" && s.canvasProjectId === canvasProjectId);
                if (existing) {
                    set({ streamingText: "", runningTool: null });
                    return existing.id;
                }
            } else if (scope === "chat") {
                const currentActive = get().sessions.find((s) => s.id === get().activeSessionId && s.scope !== "canvas");
                if (currentActive && currentActive.messages.length === 0) {
                    return currentActive.id;
                }
            }
            const session = createSessionRecord(options);
            set((state) => ({
                sessions: [session, ...state.sessions].slice(0, MAX_SESSIONS),
                activeSessionId: scope === "chat" ? session.id : state.activeSessionId,
                streamingText: "",
                runningTool: null,
            }));
            schedulePersist();
            return session.id;
        },
        deleteSession: (id) => {
            set((state) => {
                const sessions = state.sessions.filter((session) => session.id !== id);
                const activeSessionId = state.activeSessionId === id ? (sessions[0]?.id ?? null) : state.activeSessionId;
                return { sessions, activeSessionId };
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
            set({ activeSessionId: id, streamingText: "", runningTool: null });
            schedulePersist();
        },
        appendMessages: (sessionId, messages) => {
            if (!messages.length) return;
            set((state) => ({
                sessions: state.sessions.map((session) => {
                    if (session.id !== sessionId) return session;
                    const existing = new Set(session.messages.map((message) => message.id));
                    const merged = [...session.messages, ...messages.filter((message) => !existing.has(message.id))].slice(-MAX_MESSAGES);
                    const userMsg = merged.find((message) => message.role === "user");
                    const title = session.title || (userMsg?.text ? formatSessionTitle(userMsg.text) : "");
                    return { ...session, messages: merged, title, updatedAt: Date.now() };
                }),
            }));
            schedulePersist();
        },
        setStreamingText: (text) => set({ streamingText: text }),
        setRunning: (running) => set({ running, ...(running ? {} : { streamingText: "", runningTool: null }) }),
        setRunningTool: (call) => set({ runningTool: call }),
        setLaunchContext: (context) => set({ launchContext: context }),
        clearAll: () => {
            set({ sessions: [], activeSessionId: null, streamingText: "", running: false, runningTool: null });
            persistSeq += 1;
            void storage.removeItem("state").catch(() => undefined);
        },
    };
});
