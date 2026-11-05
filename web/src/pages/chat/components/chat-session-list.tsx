import { Button, Input, Modal, Popconfirm } from "antd";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
        <aside className="flex h-full w-60 shrink-0 flex-col border-r border-stone-200 bg-background dark:border-stone-800">
            <div className="p-3">
                <Button block icon={<Plus className="size-4" />} onClick={onCreate}>
                    {t("chat.newSession")}
                </Button>
            </div>
            <div className="hide-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
                {sessions.length === 0 ? <div className="px-2 py-6 text-center text-xs text-stone-400">{t("chat.noSessions")}</div> : null}
                {sessions.map((session) => (
                    <div key={session.id} className={cn("group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800", session.id === activeSessionId && "bg-stone-100 dark:bg-stone-800")}>
                        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => onSelect(session.id)} title={session.title || t("chat.untitled")}>
                            {session.title || t("chat.untitled")}
                        </button>
                        <button type="button" className="shrink-0 rounded p-1 text-stone-400 opacity-0 transition hover:text-stone-700 group-hover:opacity-100 dark:hover:text-stone-200" onClick={() => openRename(session)} title={t("chat.rename")}>
                            <Pencil className="size-3.5" />
                        </button>
                        <Popconfirm title={t("chat.deleteConfirm")} onConfirm={() => onDelete(session.id)}>
                            <button type="button" className="shrink-0 rounded p-1 text-stone-400 opacity-0 transition hover:text-red-500 group-hover:opacity-100" title={t("chat.delete")}>
                                <Trash2 className="size-3.5" />
                            </button>
                        </Popconfirm>
                    </div>
                ))}
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
                <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onPressEnter={() => {
                    if (renameId) onRename(renameId, renameValue);
                    setRenameId(null);
                }} placeholder={t("chat.titlePlaceholder")} maxLength={40} />
            </Modal>
        </aside>
    );
}
