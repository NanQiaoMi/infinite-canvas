import { Dropdown, Input, type GetRef } from "antd";
import { ArrowUp, BookOpen, ChevronDown, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
        <div className="relative">
            {url ? <img src={url} alt="reference" className="size-14 rounded-lg border border-stone-200 object-cover dark:border-stone-700" /> : <div className="size-14 rounded-lg bg-black/[.04] dark:bg-white/[.06]" />}
            <button type="button" className="absolute -right-1 -top-1 rounded-full bg-stone-900 p-0.5 text-white dark:bg-stone-100 dark:text-stone-900" onClick={onRemove}>
                <X className="size-3" />
            </button>
        </div>
    );
}

export function ChatComposer({ value, onChange, onSend, onStop, running, modelLabel, references = [], onAddFiles, onRemoveReference, quotaHint }: ChatComposerProps) {
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
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const query = value.trimStart().startsWith("/") ? value.trimStart().split(/\s/)[0].toLowerCase() : "";
    const slashOpen = Boolean(query) && !running && COMMANDS.some((command) => command.command.startsWith(query) && command.command !== query);
    const matches = COMMANDS.filter((command) => command.command.startsWith(query));
    const applyCommand = (command: string) => {
        onChange(`${command} `);
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
            {slashOpen ? (
                <div className="agent-pop-in absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900">
                    {matches.map((command) => (
                        <button
                            key={command.command}
                            type="button"
                            className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition hover:bg-stone-50 dark:hover:bg-stone-800"
                            onClick={() => applyCommand(command.command)}
                        >
                            <span className="w-16 shrink-0 font-mono text-stone-500 dark:text-stone-400">{command.command}</span>
                            <span className="truncate text-stone-500 dark:text-stone-400">{t(command.labelKey)}</span>
                        </button>
                    ))}
                </div>
            ) : null}
            <div className="rounded-2xl border border-stone-300/80 bg-white p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200 focus-within:border-stone-400/80 focus-within:shadow-[0_2px_14px_rgba(0,0,0,0.06)] dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-600">
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
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            if (!running) onSend();
                        }
                    }}
                    className="!border-0 !bg-transparent !px-1 !py-1 !text-sm !shadow-none"
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
                                "flex size-8 items-center justify-center rounded-full transition-all duration-150 active:scale-90",
                                running
                                    ? "bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900"
                                    : canSend
                                      ? "bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900"
                                      : "cursor-not-allowed bg-stone-200 text-stone-400 dark:bg-stone-800 dark:text-stone-500",
                            )}
                            disabled={!running && !canSend}
                            onClick={() => (running ? onStop() : onSend())}
                            title={running ? t("chat.stop") : t("chat.send")}
                        >
                            {running ? <Square className="size-3.5" /> : <ArrowUp className="size-4" />}
                        </button>
                    </div>
                </div>
            </div>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={applyPrompt} />
        </div>
    );
}
