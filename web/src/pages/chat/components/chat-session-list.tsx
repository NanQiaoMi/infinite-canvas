import { App, Dropdown, Input, Modal } from "antd";
import { MoreHorizontal, SquarePen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { AgentSession } from "@/lib/conversation-agent/types";
import { formatSessionTitle, useConversationAgentStore } from "@/stores/use-conversation-agent-store";

type ChatSessionListProps = {
    sessions: AgentSession[];
    activeSessionId: string | null;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, title: string) => void;
    modelLabel?: string;
    quotaHint?: string;
};

export function ChatSessionList({ sessions, activeSessionId, onSelect, onCreate, onDelete, onRename, modelLabel, quotaHint }: ChatSessionListProps) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const sessionRuns = useConversationAgentStore((state) => state.sessionRuns);
    const [renameId, setRenameId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const renameSession = sessions.find((session) => session.id === renameId);
    const openRename = (session: AgentSession) => {
        setRenameId(session.id);
        setRenameValue(session.title);
    };
    const confirmDelete = (session: AgentSession) => {
        modal.confirm({
            title: t("chat.delete"),
            content: t("chat.deleteConfirm"),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: () => onDelete(session.id),
        });
    };
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-3 pb-1 pt-4">
                <div className="flex items-center gap-2 px-1 pb-4">
                    <span
                        className="size-5 shrink-0 bg-stone-800 dark:bg-stone-100"
                        style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }}
                    />
                    <span className="text-[13px] font-semibold tracking-tight text-stone-900 dark:text-stone-100">{t("meta.title")}</span>
                    <span className="rounded border border-stone-300/80 px-1 font-mono text-[9px] uppercase tracking-widest text-stone-400 dark:border-stone-700 dark:text-stone-500">agent</span>
                </div>
                <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-stone-600 transition hover:bg-black/[.045] dark:text-stone-300 dark:hover:bg-white/[.06]"
                    onClick={onCreate}
                >
                    <SquarePen className="size-4 text-stone-500 dark:text-stone-400" />
                    {t("chat.newSession")}
                </button>
                <div className="mt-5 mb-1.5 px-2.5 text-[11px] font-medium tracking-wider text-stone-500/90 dark:text-stone-400">{t("chat.sidebar.recents")}</div>
            </div>
            <div className="hover-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
                {sessions.length === 0 ? <div className="px-2 py-6 text-center text-xs text-stone-400 dark:text-stone-500">{t("chat.sidebar.empty")}</div> : null}
                {sessions.map((session) => {
                    const active = session.id === activeSessionId;
                    const isRunning = Boolean(sessionRuns[session.id]?.running);
                    const displayTitle = formatSessionTitle(session.title || "") || t("chat.untitled");
                    return (
                        <div key={session.id} className={cn("group flex items-center gap-1 rounded-lg px-2.5 py-2 transition-colors", active ? "bg-black/[.06] dark:bg-white/[.08]" : "hover:bg-black/[.04] dark:hover:bg-white/[.05]")}>
                            <button
                                type="button"
                                className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] leading-5", active ? "font-medium text-stone-900 dark:text-stone-100" : "text-stone-600 dark:text-stone-300")}
                                onClick={() => onSelect(session.id)}
                                title={session.title || t("chat.untitled")}
                            >
                                {isRunning ? (
                                    <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 dark:bg-emerald-400" title={t("chat.generating") || "正在生成..."} />
                                ) : null}
                                <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                            </button>
                            <Dropdown
                                trigger={["click"]}
                                placement="bottomRight"
                                menu={{
                                    items: [
                                        { key: "rename", label: t("chat.rename"), onClick: () => openRename(session) },
                                        { type: "divider" },
                                        { key: "delete", danger: true, label: t("chat.delete"), onClick: () => confirmDelete(session) },
                                    ],
                                }}
                            >
                                <button
                                    type="button"
                                    className="shrink-0 rounded p-1 text-stone-400 opacity-0 transition hover:text-stone-700 group-hover:opacity-100 dark:hover:text-stone-200"
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    <MoreHorizontal className="size-4" />
                                </button>
                            </Dropdown>
                        </div>
                    );
                })}
            </div>
            <div className="shrink-0 border-t border-stone-200/70 px-3 py-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <span className="min-w-0 truncate font-mono">{modelLabel || "agent"}</span>
                    {quotaHint ? <span className="ml-auto shrink-0 tabular-nums text-stone-400 dark:text-stone-500">{quotaHint}</span> : null}
                </div>
            </div>
            <Modal
                open={Boolean(renameSession)}
                title={t("chat.rename")}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                onCancel={() => setRenameId(null)}
                onOk={() => {
                    if (renameId) onRename(renameId, renameValue);
                    setRenameId(null);
                }}
            >
                <Input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onPressEnter={() => {
                        if (renameId) onRename(renameId, renameValue);
                        setRenameId(null);
                    }}
                    placeholder={t("chat.titlePlaceholder")}
                    maxLength={40}
                />
            </Modal>
        </div>
    );
}
