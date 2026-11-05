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
    const chips: Array<{ label: string; text: string }> = [
        { label: t("chat.quickLabels.write"), text: t("chat.quick.write") },
        { label: t("chat.quickLabels.optimize"), text: t("chat.quick.optimize") },
        { label: t("chat.quickLabels.generate"), text: t("chat.quick.generate") },
        { label: t("chat.quickLabels.style"), text: t("chat.quick.style") },
    ];
    const applyChip = (text: string) => {
        const template = /[：:]$/.test(text);
        onChange(template && value.trim() ? `${text}${value.trim()}` : text);
    };
    return (
        <div className="shrink-0 border-t border-stone-200 bg-card px-4 py-3 dark:border-stone-800">
            <div className="mx-auto max-w-3xl space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
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
                            <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                {t("chat.actions.uploadReference")}
                            </Button>
                        </>
                    ) : null}
                    {chips.map((chip) => (
                        <Button key={chip.label} size="small" onClick={() => applyChip(chip.text)}>
                            {chip.label}
                        </Button>
                    ))}
                </div>
                <div className="rounded-lg border border-stone-200 bg-background p-2 transition-colors focus-within:border-stone-300 dark:border-stone-800 dark:bg-stone-950/40 dark:focus-within:border-stone-700">
                    {references.length ? (
                        <div className="mb-2 flex flex-wrap gap-2">
                            {references.map((reference) => (
                                <ReferenceThumb key={reference.id} image={reference} onRemove={() => onRemoveReference?.(reference.id)} />
                            ))}
                        </div>
                    ) : null}
                    <Input.TextArea
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
                        className="!border-0 !bg-transparent !shadow-none"
                    />
                    <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[11px] text-stone-400 dark:text-stone-500">
                            {t("chat.inputHint")}
                            {modelLabel ? ` · ${t("chat.modelLabel", { model: modelLabel })}` : ""}
                            {quotaHint ? ` · ${quotaHint}` : ""}
                        </span>
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
    );
}
