import { Button, Input, Tag } from "antd";
import { Send, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

type ChatComposerProps = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    running: boolean;
    modelLabel: string;
};

export function ChatComposer({ value, onChange, onSend, onStop, running, modelLabel }: ChatComposerProps) {
    const { t } = useTranslation();
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
        <div className="border-t border-stone-200 bg-background px-4 pb-4 pt-3 dark:border-stone-800">
            <div className="mx-auto max-w-3xl space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                    {chips.map((chip) => (
                        <Button key={chip.label} size="small" onClick={() => applyChip(chip.text)}>
                            {chip.label}
                        </Button>
                    ))}
                    <span className="ml-auto text-[11px] text-stone-400">{modelLabel ? t("chat.modelLabel", { model: modelLabel }) : ""}</span>
                </div>
                <div className="rounded-xl border border-stone-200 bg-white p-2 shadow-sm dark:border-stone-800 dark:bg-stone-900">
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
                        <span className="text-[11px] text-stone-400">{t("chat.inputHint")}</span>
                        {running ? (
                            <Button danger icon={<Square className="size-3.5" />} onClick={onStop}>
                                {t("chat.stop")}
                            </Button>
                        ) : (
                            <Button type="primary" icon={<Send className="size-3.5" />} disabled={!value.trim()} onClick={onSend}>
                                {t("chat.send")}
                            </Button>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-stone-400">
                    <Tag bordered={false}>{t("chat.internalOnly")}</Tag>
                </div>
            </div>
        </div>
    );
}
