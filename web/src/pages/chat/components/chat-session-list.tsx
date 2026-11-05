import { Button, Input, Modal, Popconfirm } from "antd";
import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { AgentSession } from "@/lib/conversation-agent/types";

type ChatSessionListProps = {
    sessions: AgentSession[];
    activeSessionId: string | null;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, title: string) => void;
};

function formatSessionTime(timestamp: number) {
    const date = new Date(timestamp);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function ChatSessionList({ sessions, activeSessionId, onSelect, onCreate, onDelete, onRename }: ChatSessionListProps) {
    const { t } = useTranslation();
    const [renameId, setRenameId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const renameSession = sessions.find((session) => session.id === renameId);
    const openRename = (session: AgentSession) => {
        setRenameId(session.id);
        setRenameValue(session.title);
    };
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-200 px-3 py-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">
                    <MessageSquare className="size-3.5" />
                    {t("chat.sessionList")}
                </div>
                <Button size="small" type="text" icon={<Plus className="size-4" />} onClick={onCreate} title={t("chat.newSession")} />
            </div>
            <div className="hover-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                {sessions.length === 0 ? <div className="px-2 py-8 text-center text-xs text-stone-400 dark:text-stone-500">{t("chat.noSessions")}</div> : null}
                {sessions.map((session) => {
                    const active = session.id === activeSessionId;
                    return (
                        <div
                            key={session.id}
                            className={cn(
                                "group flex items-center gap-1 rounded-md px-2 py-2 transition-colors",
                                active ? "bg-black/[.055] dark:bg-white/[.09]" : "hover:bg-black/[.035] dark:hover:bg-white/[.06]",
                            )}
                        >
                            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(session.id)} title={session.title || t("chat.untitled")}>
                                <div className={cn("truncate text-[13px] leading-5", active ? "text-stone-950 dark:text-stone-100" : "text-stone-700 dark:text-stone-300")}>{session.title || t("chat.untitled")}</div>
                                <div className="mt-0.5 text-[11px] tabular-nums text-stone-400 dark:text-stone-500">{formatSessionTime(session.updatedAt)}</div>
                            </button>
                            <button
                                type="button"
                                className="shrink-0 rounded p-1 text-stone-400 opacity-0 transition hover:text-stone-700 group-hover:opacity-100 dark:hover:text-stone-200"
                                onClick={() => openRename(session)}
                                title={t("chat.rename")}
                            >
                                <Pencil className="size-3.5" />
                            </button>
                            <Popconfirm title={t("chat.deleteConfirm")} onConfirm={() => onDelete(session.id)}>
                                <button type="button" className="shrink-0 rounded p-1 text-stone-400 opacity-0 transition hover:text-red-500 group-hover:opacity-100" title={t("chat.delete")}>
                                    <Trash2 className="size-3.5" />
                                </button>
                            </Popconfirm>
                        </div>
                    );
                })}
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
