import { Button, Input } from "antd";
import { ImagePlus, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentImageRef } from "@/lib/conversation-agent/types";
import { ensureImagePreview, resolveImageUrl } from "@/services/image-storage";

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

const COMMANDS = ["/prompt", "/image", "/edit", "/new", "/help"] as const;

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
            {url ? <img src={url} alt="reference" className="size-12 rounded-md border border-stone-200 object-cover dark:border-stone-700" /> : <div className="size-12 rounded-md bg-black/[.04] dark:bg-white/[.06]" />}
            <button type="button" className="absolute -right-1 -top-1 rounded-full bg-stone-900 p-0.5 text-white dark:bg-stone-100 dark:text-stone-900" onClick={onRemove}>
                <X className="size-3" />
            </button>
        </div>
    );
}

export function ChatComposer({ value, onChange, onSend, onStop, running, modelLabel, references = [], onAddFiles, onRemoveReference, quotaHint }: ChatComposerProps) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const applyCommand = (command: string) => {
        onChange(`${command} `);
        textareaRef.current?.focus();
    };
    return (
        <div className="shrink-0 border-t border-stone-200 bg-card px-4 py-3 dark:border-stone-800">
            <div className="mx-auto max-w-4xl">
                <div className="rounded-lg border border-stone-200 bg-background transition-colors focus-within:border-stone-300 focus-within:ring-2 focus-within:ring-stone-200/50 dark:border-stone-800 dark:bg-stone-950/40 dark:focus-within:border-stone-700 dark:focus-within:ring-stone-800/60">
                    <div className="flex items-start gap-2 px-3 pt-2.5">
                        <span className="select-none pt-0.5 font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">❯</span>
                        <Input.TextArea
                            ref={(node) => {
                                textareaRef.current = node?.resizableTextArea?.textArea ?? null;
                            }}
                            value={value}
                            onChange={(event) => onChange(event.target.value)}
                            placeholder={t("chat.placeholder")}
                            autoSize={{ minRows: 2, maxRows: 8 }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    if (!running) onSend();
                                }
                            }}
                            className="!border-0 !bg-transparent !p-0 !shadow-none"
                        />
                    </div>
                    {references.length ? (
                        <div className="flex flex-wrap gap-2 px-3 pt-2">
                            {references.map((reference) => (
                                <ReferenceThumb key={reference.id} image={reference} onRemove={() => onRemoveReference?.(reference.id)} />
                            ))}
                        </div>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-stone-200/70 px-2.5 py-1.5 dark:border-stone-800/70">
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                            <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("chat.commands.label")}</span>
                            {COMMANDS.map((command) => (
                                <button
                                    key={command}
                                    type="button"
                                    className="rounded border border-stone-200 px-1.5 py-px font-mono text-[10px] text-stone-500 transition hover:border-stone-300 hover:text-stone-700 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-200"
                                    onClick={() => applyCommand(command)}
                                >
                                    {command}
                                </button>
                            ))}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <span className="hidden text-[11px] text-stone-400 sm:inline dark:text-stone-500">
                                {quotaHint ? `${quotaHint} · ` : ""}
                                {modelLabel ? t("chat.modelLabel", { model: modelLabel }) : ""}
                            </span>
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
                                    <Button size="small" type="text" icon={<ImagePlus className="size-3.5" />} onClick={() => fileInputRef.current?.click()} title={t("chat.actions.uploadReference")} />
                                </>
                            ) : null}
                            {running ? (
                                <Button danger size="small" icon={<Square className="size-3.5" />} onClick={onStop}>
                                    {t("chat.stop")}
                                </Button>
                            ) : (
                                <Button type="primary" size="small" icon={<Send className="size-3.5" />} disabled={!value.trim()} onClick={onSend}>
                                    {t("chat.send")}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
