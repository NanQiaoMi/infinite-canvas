import localforage from "localforage";
import { nanoid } from "nanoid";
import { create } from "zustand";

import type { AgentLaunchContext, AgentMessage, AgentSession, AgentToolCall } from "@/lib/conversation-agent/types";

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
    hydrate: () => Promise<void>;
    createSession: () => string;
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

function createSessionRecord(): AgentSession {
    const now = Date.now();
    return { id: nanoid(), title: "", messages: [], createdAt: now, updatedAt: now };
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
        .map((item) => ({
            id: String(item.id || nanoid()),
            title: String(item.title || ""),
            messages: sanitizeMessages(item.messages).map((message) => (message.role === "assistant" ? { ...message, promptBlocks: Array.isArray(message.promptBlocks) ? message.promptBlocks : [] } : message)),
            createdAt: Number(item.createdAt) || Date.now(),
            updatedAt: Number(item.updatedAt) || Date.now(),
        }))
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
        hydrate: async () => {
            if (get().hydrated) return;
            try {
                const saved = await storage.getItem<PersistedState>("state");
                const sessions = sanitizeSessions(saved?.sessions);
                const activeId = saved?.activeSessionId && sessions.some((session) => session.id === saved.activeSessionId) ? saved.activeSessionId : sessions[0]?.id ?? null;
                set({ sessions, activeSessionId: activeId, hydrated: true });
            } catch {
                set({ hydrated: true });
            }
        },
        createSession: () => {
            const session = createSessionRecord();
            set((state) => ({ sessions: [session, ...state.sessions].slice(0, MAX_SESSIONS), activeSessionId: session.id, streamingText: "", runningTool: null }));
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
                    const title = session.title || messages.find((message) => message.role === "user")?.text.slice(0, 24) || "";
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
