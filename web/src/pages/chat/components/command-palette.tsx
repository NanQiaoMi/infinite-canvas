import { Input } from "antd";
import { MessageSquare, Plus, Search, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentSession } from "@/lib/conversation-agent/types";
import { selectChatSessions } from "@/lib/conversation-agent/session-view";
import { cn } from "@/lib/utils";

type CommandPaletteProps = {
    open: boolean;
    onClose: () => void;
    sessions: AgentSession[];
    activeSessionId: string | null;
    onSelectSession: (id: string) => void;
    onNewChat: () => void;
    onCommand: (command: string) => void;
};

type PaletteItem = { id: string; group: string; label: string; hint?: string; run: () => void };

export function CommandPalette({ open, onClose, sessions, activeSessionId, onSelectSession, onNewChat, onCommand }: CommandPaletteProps) {
    const { t } = useTranslation();
    const inputRef = useRef<{ focus: () => void } | null>(null);
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);

    const items = useMemo<PaletteItem[]>(() => {
        const actions: PaletteItem[] = [{ id: "action:new", group: t("chat.palette.actions"), label: t("chat.palette.newChat"), hint: "N", run: onNewChat }];
        const commands = [
            { command: "/prompt", labelKey: "chat.commands.items.prompt" },
            { command: "/image", labelKey: "chat.commands.items.image" },
            { command: "/edit", labelKey: "chat.commands.items.edit" },
            { command: "/model", labelKey: "chat.commands.items.model" },
            { command: "/new", labelKey: "chat.commands.items.new" },
            { command: "/help", labelKey: "chat.commands.items.help" },
        ].map<PaletteItem>((item) => ({ id: `cmd:${item.command}`, group: t("chat.palette.commands"), label: item.command, hint: t(item.labelKey), run: () => onCommand(item.command) }));
        // 命令面板只展示 chat 会话：画布会话由画布助手维护，不能从这里切进对话页。
        const recent = selectChatSessions(sessions)
            .slice(0, 6)
            .map<PaletteItem>((session) => ({
                id: `session:${session.id}`,
                group: t("chat.palette.sessions"),
                label: session.title || t("chat.untitled"),
                hint: session.id === activeSessionId ? t("chat.palette.current") : undefined,
                run: () => onSelectSession(session.id),
            }));
        return [...actions, ...commands, ...recent];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessions, activeSessionId, onNewChat, onSelectSession, onCommand, t]);

    const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return keyword ? items.filter((item) => `${item.label} ${item.hint || ""} ${item.group}`.toLowerCase().includes(keyword)) : items;
    }, [items, query]);

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setIndex(0);
        window.setTimeout(() => inputRef.current?.focus(), 30);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => (filtered.length ? (value + 1) % filtered.length : 0));
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => (filtered.length ? (value - 1 + filtered.length) % filtered.length : 0));
            } else if (event.key === "Enter") {
                const item = filtered[index];
                if (!item) return;
                event.preventDefault();
                item.run();
                onClose();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [open, filtered, index, onClose]);

    useEffect(() => {
        setIndex(0);
    }, [query]);

    if (!open) return null;

    return (
        <div className="agent-overlay-in fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-[16vh] backdrop-blur-[2px]" onMouseDown={onClose}>
            <div className="agent-pop-in w-full max-w-xl overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900" onMouseDown={(event) => event.stopPropagation()}>
                <div className="flex items-center gap-2 border-b border-stone-200/80 px-3.5 py-3 dark:border-stone-800">
                    <Search className="size-4 shrink-0 text-stone-400" />
                    <Input
                        ref={(node) => {
                            inputRef.current = node?.input ?? null;
                        }}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("chat.palette.placeholder")}
                        className="!border-0 !bg-transparent !p-0 !text-sm !shadow-none"
                    />
                </div>
                <div className="hover-scrollbar max-h-[320px] overflow-y-auto p-1.5">
                    {filtered.length === 0 ? <div className="px-3 py-8 text-center text-xs text-stone-400">{t("chat.palette.empty")}</div> : null}
                    {filtered.map((item, itemIndex) => {
                        const showGroup = itemIndex === 0 || filtered[itemIndex - 1]?.group !== item.group;
                        const Icon = item.id.startsWith("cmd:") ? Terminal : item.id.startsWith("session:") ? MessageSquare : Plus;
                        return (
                            <div key={item.id}>
                                {showGroup ? <div className="px-2 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{item.group}</div> : null}
                                <button
                                    type="button"
                                    className={cn(
                                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                                        itemIndex === index ? "bg-black/[.06] text-stone-900 dark:bg-white/[.09] dark:text-stone-100" : "text-stone-600 dark:text-stone-300",
                                    )}
                                    onMouseEnter={() => setIndex(itemIndex)}
                                    onClick={() => {
                                        item.run();
                                        onClose();
                                    }}
                                >
                                    <Icon className="size-4 shrink-0 text-stone-400 dark:text-stone-500" />
                                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                                    {item.hint ? <span className="shrink-0 truncate text-[11px] text-stone-400 dark:text-stone-500">{item.hint}</span> : null}
                                </button>
                            </div>
                        );
                    })}
                </div>
                <div className="flex items-center gap-4 border-t border-stone-200/80 px-3.5 py-1.5 text-[10px] text-stone-400 dark:border-stone-800 dark:text-stone-500">
                    <span>{t("chat.palette.hintSelect")}</span>
                    <span>{t("chat.palette.hintConfirm")}</span>
                    <span>{t("chat.palette.hintClose")}</span>
                </div>
            </div>
        </div>
    );
}
