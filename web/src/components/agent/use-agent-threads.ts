import { useCallback, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { App } from "antd";

import i18n from "@/i18n";
import { acknowledgeCodexHistory, agentPath, fetchAgentJson, resetAgentThread } from "@/services/api/canvas-agent";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useAgentStore, type AgentBootstrapStatus, type AgentChatItem, type AgentConversationState, type AgentPendingToolCall, type AgentReasoningEffort, type AgentRuntimeName, type AgentThreadSummary } from "@/stores/use-agent-store";
import { mergeAgentMessages, normalizeHistoryMessages, scopeChatItem } from "./agent-event-formatters";
import { agentErrorState, rt } from "./agent-panel-utils";

const HISTORY_RETRY_DELAYS_MS = [0, 150, 350, 700, 1200];
/** 切换本地运行时，并让界面文案中的 {{agent}} 跟随当前运行时。 */
export function syncRuntime(next: AgentRuntimeName) {
    if (i18n.options.interpolation) i18n.options.interpolation.defaultVariables = { agent: next === "claude" ? "Claude" : "Codex" };
    if (useAgentStore.getState().runtime === next) return;
    try {
        localStorage.setItem("canvas-agent-runtime", next);
    } catch {}
    useAgentStore.getState().setAgentState({
        runtime: next,
        threadSearch: "",
        threadsNextCursor: "",
        models: [],
        model: localStorage.getItem(`canvas-agent-model:${next}`) || "",
        reasoningEffort: (localStorage.getItem(`canvas-agent-reasoning-effort:${next}`) as AgentReasoningEffort | null) || "",
    });
}
type AgentWorkspace = { workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; data?: AgentThreadSummary[]; nextCursor?: string | null };
/** 历史列表请求路径，带上当前搜索词与分页游标（空值不拼入）。 */
function threadsPath(cursor = "") {
    const params = new URLSearchParams();
    const searchTerm = useAgentStore.getState().threadSearch;
    if (searchTerm) params.set("searchTerm", searchTerm);
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    return agentPath(`/threads${query ? `?${query}` : ""}`);
}
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; thread?: AgentThreadSummary; messages?: AgentChatItem[]; settledTurnIds?: string[]; historyReady?: boolean };
export type AgentWorkspaceEvent = { activeThreadId?: string; runtime?: AgentRuntimeName; threadId?: string; sourceClientId?: string; emptyThread?: boolean; draftThread?: boolean; conversation?: AgentConversationState };
function authoritativeHistoryTurnKeys(threadId: string, settledTurnIds: string[]) {
    return new Set(settledTurnIds.map((turnId) => `${threadId}\0${turnId}`));
}
function conversationBootstrapView(conversation: AgentConversationState) {
    const mcpStartupStatuses: Record<string, AgentBootstrapStatus> = Object.fromEntries(Object.entries(conversation.mcpStatuses).map(([name, item]) => {
        const view: AgentBootstrapStatus = item.status === "starting"
            ? { key: `mcp:${name}:starting`, text: rt("mcpStarting", { name }), detail: rt("mcpConnecting"), status: "running" }
            : item.status === "ready"
                ? { key: `mcp:${name}:ready`, text: rt("mcpReadyNamed", { name }), detail: rt("toolsReady"), status: "ready" }
                : { key: `mcp:${name}:${item.status}`, text: rt(item.status === "failed" ? "mcpFailedNamed" : "mcpCanceledNamed", { name }), detail: item.error || rt("toolInitFailed"), status: "error" };
        return [name, view];
    }));
    const services = Object.values(mcpStartupStatuses);
    const pending = services.filter((item) => item.status === "running").length;
    const bootstrapStatus: AgentBootstrapStatus | null = conversation.status === "idle" || conversation.status === "preparing"
        ? services.length
            ? { key: "mcp:starting", text: rt("mcpServicesStarting"), detail: pending ? rt("toolServicesPending", { count: pending }) : rt("checkingToolServices"), status: "running" }
            : { key: "codex:preparing", text: rt("conversationInitializing"), detail: rt("conversationCreating"), status: "running" }
        : conversation.status === "warning"
            ? { key: "mcp:warning", text: rt("someMcpFailed"), detail: rt("remainingToolsReady"), status: "error" }
            : conversation.status === "failed"
                ? { key: "codex:prepare_failed", text: rt("conversationInitFailed"), detail: conversation.error || rt("conversationCreateFailed"), status: "error" }
                : conversation.status === "ready"
                    ? { key: "mcp:ready", text: rt("mcpServicesReady", { count: services.length }), detail: rt("toolsReady"), status: "ready" }
                    : null;
    return { bootstrapStatus, mcpStartupStatuses };
}
function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
export function useAgentThreads({ endpoint, clientIdRef, connectedRef, pendingToolRef, liveTurnKeysRef, addEventLog }: {
    endpoint: string;
    clientIdRef: RefObject<string>;
    connectedRef: RefObject<boolean>;
    pendingToolRef: RefObject<AgentPendingToolCall | null>;
    liveTurnKeysRef: RefObject<Set<string>>;
    addEventLog: (title: string, text: unknown, raw?: unknown) => void;
}) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const token = useAgentStore((state) => state.token);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const connected = useAgentStore((state) => state.connected);
    const sending = useAgentStore((state) => state.sending);
    const waiting = useAgentStore((state) => state.waiting);
    const loadingThreads = useAgentStore((state) => state.loadingThreads);
    const permissionMode = useAgentStore((state) => state.permissionMode);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);
    const loadThreadsSequenceRef = useRef(0);
    const loadingMoreThreadsRef = useRef(false);
    const threadMessagesRef = useRef(new Map<string, AgentChatItem[]>());
    const authoritativeHistoryTurnsRef = useRef(new Set<string>());
    const threadOperationRef = useRef(0);
    const threadOperationSequenceRef = useRef(0);
    const loadThreadSnapshot = useCallback(async (threadId: string, sequence: number, response?: AgentThreadResponse, expectedTurnId = "") => {
        let thread = response;
        let lastError: unknown;
        for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
            if (delayMs) await delay(delayMs);
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== threadId) return false;
            try {
                thread ||= await fetchAgentJson<AgentThreadResponse>(endpoint, token, agentPath(`/threads/${encodeURIComponent(threadId)}`));
                lastError = undefined;
            } catch (error) {
                lastError = error;
                thread = undefined;
                continue;
            }
            const history = normalizeHistoryMessages(thread.messages || []);
            const latest = useAgentStore.getState();
            if (sequence !== loadThreadsSequenceRef.current || latest.activeThreadId !== threadId) return false;
            const historyTurns = authoritativeHistoryTurnKeys(threadId, thread.settledTurnIds || []);
            const hasExpectedTurn = !expectedTurnId || historyTurns.has(`${threadId}\0${expectedTurnId}`);
            historyTurns.forEach((key) => liveTurnKeysRef.current.delete(key));
            if (latest.activeTurnId) liveTurnKeysRef.current.add(`${threadId}\0${latest.activeTurnId}`);
            authoritativeHistoryTurnsRef.current = historyTurns;
            const messages = mergeAgentMessages(history, latest.messages, threadId, liveTurnKeysRef.current);
            threadMessagesRef.current.set(threadId, messages);
            setAgentState({ messages, connectError: "" });
            const coveredTurnIds = [...historyTurns].map((key) => key.slice(threadId.length + 1));
            if (coveredTurnIds.length) void acknowledgeCodexHistory(endpoint, token, threadId, coveredTurnIds).catch(() => undefined);
            if (hasExpectedTurn && (thread.historyReady !== false || Boolean(expectedTurnId))) return true;
            thread = undefined;
        }
        if (lastError) throw lastError;
        return false;
    }, [endpoint, setAgentState, token]);
    const applyWorkspaceChange = useCallback((data: AgentWorkspaceEvent) => {
        const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
        const current = useAgentStore.getState();
        const threadChanged = current.activeThreadId !== nextThreadId;
        const emptyThread = Boolean(data.emptyThread || data.draftThread);
        const pendingMessage = [...current.messages].reverse().find((item) => item.role === "user" && !item.turnId);
        const keepPendingMessage = Boolean(
            data.emptyThread
            && pendingMessage
            && (current.sending || current.waiting)
            && (!data.sourceClientId || data.sourceClientId === clientIdRef.current),
        );
        if (threadChanged && current.activeThreadId) {
            const messages = keepPendingMessage ? current.messages.filter((item) => item.id !== pendingMessage!.id) : current.messages;
            threadMessagesRef.current.set(current.activeThreadId, messages);
        }
        if (emptyThread && nextThreadId) threadMessagesRef.current.delete(nextThreadId);
        if (threadChanged || emptyThread) {
            loadThreadsSequenceRef.current += 1;
            authoritativeHistoryTurnsRef.current.clear();
            liveTurnKeysRef.current.clear();
        }
        const messages = keepPendingMessage
            ? [scopeChatItem(pendingMessage!, nextThreadId, "")]
            : emptyThread ? []
                : threadChanged ? threadMessagesRef.current.get(nextThreadId) || []
                    : current.messages;
        pendingToolRef.current = null;
        setAgentState({
            activeThreadId: nextThreadId,
            activeTurnId: threadChanged || emptyThread ? "" : current.activeTurnId,
            messages,
            tokenUsage: threadChanged || emptyThread ? null : current.tokenUsage,
            pendingTool: null,
            pendingApprovals: threadChanged || emptyThread ? [] : current.pendingApprovals,
        });
        return loadThreadsSequenceRef.current;
    }, [setAgentState]);
    const applyConversationState = useCallback((next: AgentConversationState, force = false) => {
        const current = useAgentStore.getState();
        if (!next?.revision || !force && next.revision <= current.conversation.revision) return false;
        const conversationChanged = next.conversationId !== current.conversation.conversationId;
        if (conversationChanged || next.threadId !== current.activeThreadId) {
            applyWorkspaceChange({
                activeThreadId: next.threadId,
                emptyThread: conversationChanged || !current.activeThreadId,
                draftThread: next.status === "preparing",
                sourceClientId: next.sourceClientId,
            });
        }
        setAgentState({ conversation: next, ...conversationBootstrapView(next) });
        return true;
    }, [applyWorkspaceChange, setAgentState]);
    const loadThreads = useCallback(async (skipHistory = false, expectedTurnId = "") => {
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        let sequence = ++loadThreadsSequenceRef.current;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, threadsPath());
            if (sequence !== loadThreadsSequenceRef.current) return;
            if (data.conversation) {
                applyConversationState(data.conversation);
                sequence = loadThreadsSequenceRef.current;
            }
            const current = useAgentStore.getState();
            const currentThreadId = current.activeThreadId || data.workspace?.activeThreadId || "";
            if (!data.conversation && currentThreadId !== current.activeThreadId) sequence = applyWorkspaceChange({ activeThreadId: currentThreadId });
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== currentThreadId) return;
            setAgentState({ threads: data.data || [], threadsNextCursor: data.nextCursor || "", workspacePath: data.workspace?.workspacePath || "" });
            if (currentThreadId && !skipHistory) {
                await loadThreadSnapshot(currentThreadId, sequence, undefined, expectedTurnId);
            } else {
                authoritativeHistoryTurnsRef.current.clear();
                liveTurnKeysRef.current.clear();
            }
        } catch (error) {
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            if (sequence === loadThreadsSequenceRef.current && !threadOperationRef.current) setAgentState({ loadingThreads: false });
        }
    }, [applyConversationState, applyWorkspaceChange, endpoint, loadThreadSnapshot, setAgentState, token]);
    const loadMoreThreads = useCallback(async () => {
        const current = useAgentStore.getState();
        if (!current.connected || !current.threadsNextCursor || loadingMoreThreadsRef.current) return;
        const sequence = loadThreadsSequenceRef.current;
        loadingMoreThreadsRef.current = true;
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, threadsPath(current.threadsNextCursor));
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().threadSearch !== current.threadSearch) return;
            const latest = useAgentStore.getState();
            const ids = new Set(latest.threads.map((thread) => thread.id));
            setAgentState({ threads: [...latest.threads, ...(data.data || []).filter((thread) => !ids.has(thread.id))], threadsNextCursor: data.nextCursor || "" });
        } catch (error) {
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            loadingMoreThreadsRef.current = false;
        }
    }, [endpoint, setAgentState, token]);
    /** 搜索只刷新历史列表，不触碰当前对话的历史快照与实时消息去重状态。 */
    const searchThreads = useCallback(async (term: string) => {
        const threadSearch = term.trim();
        setAgentState({ threadSearch, loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, threadsPath());
            if (useAgentStore.getState().threadSearch !== threadSearch) return;
            setAgentState({ threads: data.data || [], threadsNextCursor: data.nextCursor || "" });
        } catch (error) {
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            if (useAgentStore.getState().threadSearch === threadSearch) setAgentState({ loadingThreads: false });
        }
    }, [endpoint, setAgentState, token]);
    const beginThreadOperation = () => {
        const operation = ++threadOperationSequenceRef.current;
        threadOperationRef.current = operation;
        setAgentState({ loadingThreads: true });
        return operation;
    };

    const finishThreadOperation = (operation: number) => {
        if (threadOperationRef.current !== operation) return;
        threadOperationRef.current = 0;
        setAgentState({ loadingThreads: false });
    };
    const switchRuntime = async (next: AgentRuntimeName) => {
        const current = useAgentStore.getState();
        if (next === current.runtime) return;
        if (current.connected && (current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status))) {
            message.warning(t("agent.panel.runtimeBusy"));
            return;
        }
        syncRuntime(next);
        setAgentState({ messages: [], threads: [], activeThreadId: "", activeTurnId: "", tokenUsage: null });
        if (current.connected) {
            await startNewThread();
            await loadThreads(true);
        }
    };

    const startNewThread = async () => {
        const current = useAgentStore.getState();
        if (!current.connected || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        clearSkillSelection();
        setAgentState({ activeTab: "chat", activity: rt("creatingConversation") });
        try {
            const result = await resetAgentThread(endpoint, token, clientIdRef.current, permissionMode);
            if (threadOperationRef.current !== operation) return;
            if (result.conversation) applyConversationState(result.conversation);
            setAgentState({ activeTab: "chat", activity: rt("newConversation") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("newConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("newConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const resumeThread = async (threadId: string) => {
        const current = useAgentStore.getState();
        if (!current.connected || !threadId || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        try {
            const result = await fetchAgentJson<AgentThreadResponse>(endpoint, token, agentPath(`/threads/${encodeURIComponent(threadId)}/resume`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode, clientId: clientIdRef.current }) });
            if (result.conversation) applyConversationState(result.conversation);
            await loadThreads();
            if (useAgentStore.getState().activeThreadId === threadId) setAgentState({ activeTab: "chat", activity: rt("conversationResumed") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("resumeConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("resumeConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const deleteThreads = async (threadIds: string[]) => {
        if (!connected || !threadIds.length || sending || waiting || loadingThreads) return;
        const operation = beginThreadOperation();
        let deletedCount = 0;
        try {
            for (const threadId of new Set(threadIds)) {
                await fetchAgentJson(endpoint, token, agentPath(`/threads/${encodeURIComponent(threadId)}/delete`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current }) });
                threadMessagesRef.current.delete(threadId);
                deletedCount += 1;
            }
            await loadThreads();
            message.success(rt("recordsDeleted", { count: deletedCount }));
        } catch (error) {
            await loadThreads();
            addEventLog(rt("deleteConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("deleteConversationFailed"));
        } finally {
            finishThreadOperation(operation);
        }
    };

    const confirmDeleteThreads = (threadIds: string[]) => {
        modal.confirm({
            title: rt("deleteConversations", { count: threadIds.length }),
            content: rt("deleteConversationsDescription"),
            okText: t("common.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: () => deleteThreads(threadIds),
        });
    };
    return { loadThreadSnapshot, applyWorkspaceChange, applyConversationState, loadThreads, loadMoreThreads, searchThreads, beginThreadOperation, finishThreadOperation, switchRuntime, startNewThread, resumeThread, deleteThreads, confirmDeleteThreads, loadThreadsSequenceRef, threadMessagesRef, authoritativeHistoryTurnsRef, threadOperationRef };
}
