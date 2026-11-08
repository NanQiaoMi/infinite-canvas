import { Dropdown, Input, type GetRef } from "antd";
import { ArrowUp, BookOpen, Bug, ChevronDown, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import type { AgentImageRef } from "@/lib/conversation-agent/types";
import { ensureImagePreview, resolveImageUrl } from "@/services/image-storage";
import { cn } from "@/lib/utils";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";

type ChatComposerProps = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    running: boolean;
    modelLabel: string;
    references?: AgentImageRef[];
    onAddFiles?: (files: File[]) => void;
    onRemoveReference?: (id: string) => void;
    quotaHint?: string;
    /** 打开生成诊断（记录生成/模型失败，便于排查问题）。 */
    onOpenDiagnostics?: () => void;
};

const COMMANDS = [
    { command: "/prompt", labelKey: "chat.commands.items.prompt" },
    { command: "/image", labelKey: "chat.commands.items.image" },
    { command: "/edit", labelKey: "chat.commands.items.edit" },
    { command: "/new", labelKey: "chat.commands.items.new" },
    { command: "/model", labelKey: "chat.commands.items.model" },
    { command: "/help", labelKey: "chat.commands.items.help" },
];

function ReferenceThumb({ image, onRemove }: { image: AgentImageRef; onRemove: () => void }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let active = true;
        void ensureImagePreview(image.storageKey);
        void resolveImageUrl(image.storageKey).then((value) => {
            if (active) setUrl(value);
        });
        return () => {
            active = false;
        };
    }, [image.storageKey]);
    return (
        <div className="group relative">
            {url ? (
                <img
                    src={url}
                    alt="reference"
                    className="size-14 rounded-lg border border-stone-200/80 object-cover shadow-sm transition-transform duration-200 group-hover:scale-105 dark:border-stone-700/80"
                />
            ) : (
                <div className="size-14 rounded-lg bg-black/[.04] dark:bg-white/[.06]" />
            )}
            <button
                type="button"
                className="absolute -right-1 -top-1 rounded-full bg-stone-900 p-0.5 text-white shadow-sm transition hover:scale-110 dark:bg-stone-100 dark:text-stone-900"
                onClick={onRemove}
            >
                <X className="size-3" />
            </button>
        </div>
    );
}

export function ChatComposer({ value, onChange, onSend, onStop, running, modelLabel, references = [], onAddFiles, onRemoveReference, quotaHint, onOpenDiagnostics }: ChatComposerProps) {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const allowModelSelection = useConfigStore((state) => state.publicSettings.allowModelSelection);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const textOptions = selectableModelsByCapability(config, "text");
    const currentModelLabel = modelLabel || (config.textModel ? config.textModel.split("::").pop() : "") || "";
    const modelMenu = {
        items: textOptions.map((option) => {
            const [channelId, name] = option.split("::");
            const channelName = config.channels.find((channel) => channel.id === channelId)?.name;
            return { key: option, label: channelName ? `${name} · ${channelName}` : name };
        }),
        selectable: true,
        selectedKeys: [config.textModel],
        onClick: ({ key }: { key: string }) => updateConfig("textModel", key),
    };
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const textAreaRef = useRef<GetRef<typeof Input.TextArea>>(null);
    const commandMenuRef = useRef<HTMLDivElement | null>(null);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [activeCommandIndex, setActiveCommandIndex] = useState(0);
    const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
    const query = value.trimStart().startsWith("/") ? value.trimStart().split(/\s/)[0].toLowerCase() : "";
    const matches = query ? COMMANDS.filter((command) => command.command.startsWith(query)) : [];
    const exactQuery = matches.length === 1 && matches[0].command === query;
    const commandMenuOpen = Boolean(query) && !running && !commandMenuDismissed && matches.length > 0 && !exactQuery;
    const activeCommand = commandMenuOpen ? matches[Math.min(activeCommandIndex, matches.length - 1)] : null;

    // 命令词变化时回到第一项；输入内容变化时取消 Esc 的收起状态。
    useEffect(() => setActiveCommandIndex(0), [query]);
    useEffect(() => setCommandMenuDismissed(false), [value]);
    useEffect(() => {
        if (!commandMenuOpen) return;
        const item = commandMenuRef.current?.querySelector<HTMLElement>(`[data-command-index="${activeCommandIndex}"]`);
        item?.scrollIntoView({ block: "nearest" });
    }, [activeCommandIndex, commandMenuOpen]);

    const applyCommand = (command: string) => {
        const next = `${command} `;
        onChange(next);
        // 补全后把光标留在输入框末尾，方便继续输入参数。
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                const textarea = textAreaRef.current?.resizableTextArea?.textArea;
                if (!textarea) return;
                textarea.focus();
                textarea.setSelectionRange(next.length, next.length);
            });
        });
    };

    const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing) return;
        if (commandMenuOpen && activeCommand) {
            if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                applyCommand(activeCommand.command);
                return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveCommandIndex((current) => {
                    const next = event.key === "ArrowDown" ? current + 1 : current - 1;
                    return (next + matches.length) % matches.length;
                });
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setCommandMenuDismissed(true);
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                applyCommand(activeCommand.command);
                return;
            }
        }
        // 菜单已收起（命令词已完整输入、还没写参数）时，Tab 仍然补一个空格，不把焦点移出输入框。
        if (event.key === "Tab" && !event.shiftKey && exactQuery && value.trim() === query) {
            event.preventDefault();
            applyCommand(matches[0].command);
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!running) onSend();
        }
    };
    const applyPrompt = (prompt: string) => {
        const draft = value.trimEnd();
        onChange(draft ? `${draft}\n\n${prompt}` : prompt);
        // antd Modal 关闭动画结束后会把焦点还给触发按钮，这里等动画结束后再把焦点交给输入框。
        window.setTimeout(() => textAreaRef.current?.focus(), 400);
    };
    const canSend = Boolean(value.trim()) && !running;
    return (
        <div className="relative">
            {commandMenuOpen ? (
                <div
                    ref={commandMenuRef}
                    role="listbox"
                    aria-label={t("chat.commands.label")}
                    className="agent-pop-in absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900"
                >
                    {matches.map((command, index) => {
                        const active = index === activeCommandIndex;
                        return (
                            <button
                                key={command.command}
                                type="button"
                                role="option"
                                aria-selected={active}
                                data-command-index={index}
                                className={cn(
                                    "flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition-colors",
                                    active ? "bg-stone-100 text-stone-900 dark:bg-white/[.08] dark:text-stone-100" : "text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-white/[.04]",
                                )}
                                onMouseEnter={() => setActiveCommandIndex(index)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => applyCommand(command.command)}
                            >
                                <span className="w-16 shrink-0 font-mono text-[11px] text-stone-400 dark:text-stone-500">
                                    <span className="font-semibold text-stone-800 dark:text-stone-100">{command.command.slice(0, query.length)}</span>
                                    {command.command.slice(query.length)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-stone-500 dark:text-stone-400">{t(command.labelKey)}</span>
                                {active ? (
                                    <kbd className="hidden shrink-0 rounded border border-stone-200 px-1 font-mono text-[9px] text-stone-400 sm:inline-block dark:border-stone-700 dark:text-stone-500">
                                        Tab
                                    </kbd>
                                ) : null}
                            </button>
                        );
                    })}
                    <div className="flex items-center justify-end gap-2.5 border-t border-stone-200/70 px-3 py-1.5 text-[10px] text-stone-400 dark:border-stone-800 dark:text-stone-500">
                        <span>{t("chat.palette.hintSelect")}</span>
                        <span>{t("chat.commands.hintTab")}</span>
                        <span>{t("chat.palette.hintConfirm")}</span>
                        <span>{t("chat.palette.hintClose")}</span>
                    </div>
                </div>
            ) : null}
            <div className="rounded-2xl border border-stone-300/80 bg-white p-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all duration-200 focus-within:border-stone-400 focus-within:shadow-[0_4px_18px_rgba(0,0,0,0.06)] dark:border-stone-700/80 dark:bg-stone-900 dark:focus-within:border-stone-500 dark:focus-within:shadow-[0_4px_18px_rgba(0,0,0,0.3)]">
                {references.length ? (
                    <div className="flex flex-wrap gap-2 px-1 pb-2">
                        {references.map((reference) => (
                            <ReferenceThumb key={reference.id} image={reference} onRemove={() => onRemoveReference?.(reference.id)} />
                        ))}
                    </div>
                ) : null}
                <Input.TextArea
                    ref={textAreaRef}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder={t("chat.placeholder")}
                    autoSize={{ minRows: 2, maxRows: 10 }}
                    onKeyDown={handleComposerKeyDown}
                    className="!border-0 !bg-transparent !px-1 !py-1 !text-sm !shadow-none font-serif"
                />
                <div className="mt-1 flex items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-1">
                        {onAddFiles ? (
                            <>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        const files = [...(event.target.files ?? [])];
                                        if (files.length) onAddFiles(files);
                                        event.target.value = "";
                                    }}
                                />
                                <button
                                    type="button"
                                    className="flex size-8 items-center justify-center rounded-full text-stone-500 transition-all duration-150 hover:bg-black/[.05] active:scale-90 dark:text-stone-400 dark:hover:bg-white/[.08]"
                                    onClick={() => fileInputRef.current?.click()}
                                    title={t("chat.actions.uploadReference")}
                                >
                                    <Paperclip className="size-4" />
                                </button>
                            </>
                        ) : null}
                        <button
                            type="button"
                            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] active:scale-90 dark:text-stone-400 dark:hover:bg-white/[.08]"
                            onClick={() => setPromptDialogOpen(true)}
                            title={t("workbench.viewPrompts")}
                        >
                            <BookOpen className="size-4" />
                            <span className="whitespace-nowrap">{t("prompts.library")}</span>
                        </button>
                        {onOpenDiagnostics ? (
                            <button
                                type="button"
                                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] active:scale-90 dark:text-stone-400 dark:hover:bg-white/[.08]"
                                onClick={onOpenDiagnostics}
                                title="生成诊断"
                            >
                                <Bug className="size-4" />
                                <span className="hidden whitespace-nowrap sm:inline">诊断</span>
                            </button>
                        ) : null}
                        <span className="hidden items-center gap-1.5 pl-1 text-[11px] text-stone-400 sm:inline-flex dark:text-stone-500">
                            {t("chat.composerHint")}
                            <kbd className="rounded border border-stone-200 px-1 font-mono text-[9px] text-stone-400 dark:border-stone-700 dark:text-stone-500">⌘K</kbd>
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="hidden items-center gap-1 sm:flex">
                            {allowModelSelection ? (
                                <Dropdown menu={modelMenu} trigger={["click"]} placement="topRight" disabled={!textOptions.length}>
                                    <button type="button" className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-stone-500 transition hover:bg-black/[.05] hover:text-stone-700 dark:text-stone-400 dark:hover:bg-white/[.08] dark:hover:text-stone-200">
                                        <span className="max-w-32 truncate font-mono">{currentModelLabel}</span>
                                        <ChevronDown className="size-3" />
                                    </button>
                                </Dropdown>
                            ) : (
                                <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">{currentModelLabel}</span>
                            )}
                            {quotaHint ? <span className="text-[11px] text-stone-400 dark:text-stone-500">{quotaHint}</span> : null}
                        </span>
                        <button
                            type="button"
                            className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-xl transition-all duration-200 active:scale-95",
                                running
                                    ? "bg-[#1f1e1d] shadow-xs hover:bg-[#33312c] dark:bg-[#f2efe8] dark:hover:bg-white"
                                    : canSend
                                      ? "bg-[#1f1e1d] shadow-xs hover:scale-105 hover:bg-[#33312c] dark:bg-[#f2efe8] dark:hover:bg-white"
                                      : "cursor-not-allowed bg-stone-100 text-stone-400 dark:bg-stone-800/70 dark:text-stone-500",
                            )}
                            disabled={!running && !canSend}
                            onClick={() => (running ? onStop() : onSend())}
                            title={running ? t("chat.stop") : t("chat.send")}
                        >
                            {running ? (
                                <span className="size-2.5 rounded-[2px] bg-white animate-pulse dark:bg-stone-900" />
                            ) : (
                                <ArrowUp
                                    className={cn(
                                        "size-4 shrink-0 transition-transform duration-150",
                                        canSend ? "!text-white dark:!text-stone-900" : "text-stone-400 dark:text-stone-500",
                                    )}
                                    strokeWidth={2.75}
                                    style={canSend ? { stroke: "currentColor" } : undefined}
                                />
                            )}
                        </button>
                    </div>
                </div>
            </div>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={applyPrompt} />
        </div>
    );
}
