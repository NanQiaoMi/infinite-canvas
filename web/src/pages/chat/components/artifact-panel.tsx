import { App, Button, Input } from "antd";
import { Copy, Download, FolderPlus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

export function ArtifactPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const copyText = useCopyText();
    const artifact = useConversationAgentStore((state) => state.artifact);
    const closeArtifact = useConversationAgentStore((state) => state.closeArtifact);
    const requestReference = useConversationAgentStore((state) => state.requestReference);
    const setComposerDraft = useConversationAgentStore((state) => state.setComposerDraft);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [url, setUrl] = useState("");
    const [prompt, setPrompt] = useState("");
    const [instruction, setInstruction] = useState("");

    useEffect(() => {
        if (!artifact) return;
        setPrompt(artifact.prompt);
        let active = true;
        void resolveImageUrl(artifact.storageKey).then((value) => {
            if (active) setUrl(value);
        });
        return () => {
            active = false;
        };
    }, [artifact]);

    useEffect(() => {
        if (!artifact) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeArtifact();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [artifact, closeArtifact]);

    // 切会话会关闭产物面板：同时清空面板内的图片地址、提示词与续聊指令，避免上一个会话的内容带到下一个会话。
    useEffect(() => {
        if (artifact) return;
        setUrl("");
        setPrompt("");
        setInstruction("");
    }, [artifact]);

    if (!artifact) return null;

    const download = async () => {
        const imageUrl = await resolveImageUrl(artifact.storageKey);
        if (!imageUrl) return;
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const ext = blob.type === "image/gif" || artifact.storageKey?.endsWith(".gif") ? "gif" : "png";
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `${artifact.id}.${ext}`;
        link.click();
        URL.revokeObjectURL(objectUrl);
    };

    const saveToAssets = async () => {
        if (!artifact.storageKey) return;
        const imageUrl = await resolveImageUrl(artifact.storageKey);
        const blob = await getImageBlob(artifact.storageKey);
        addAsset({
            kind: "image",
            title: prompt.slice(0, 24) || artifact.id,
            coverUrl: "",
            tags: [],
            source: "conversation-agent",
            data: { dataUrl: imageUrl, storageKey: artifact.storageKey, width: artifact.width || 0, height: artifact.height || 0, bytes: blob?.size || 0, mimeType: blob?.type || "image/png" },
        });
        message.success(t("chat.actions.assetAdded"));
    };

    const fillWorkbench = () => {
        useWorkbenchAgentStore.getState().dispatchImage({ prompt, run: false });
        message.success(t("chat.actions.filledWorkbench"));
    };

    const continueInChat = () => {
        const text = instruction.trim();
        requestReference(artifact);
        setComposerDraft(text ? t("chat.artifact.continueDraft", { text }) : t("chat.artifact.continueDefault"));
        setInstruction("");
        closeArtifact();
    };

    return (
        <>
            <div className="agent-overlay-in fixed inset-0 z-40 bg-black/15 backdrop-blur-[1px]" onClick={closeArtifact} />
            <aside className="agent-slide-in fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-stone-200 bg-[#faf9f5] shadow-2xl dark:border-stone-800 dark:bg-[#1c1b19]">
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-stone-200/80 px-4 dark:border-stone-800">
                    <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">{t("chat.artifact.title")}</span>
                    <span className="truncate font-mono text-[10px] uppercase tracking-widest text-stone-400 dark:text-stone-500">
                        {artifact.model} · {artifact.width}×{artifact.height}
                    </span>
                    <button type="button" className="ml-auto flex size-8 items-center justify-center rounded-full text-stone-500 transition hover:bg-black/[.05] dark:text-stone-400 dark:hover:bg-white/[.08]" onClick={closeArtifact}>
                        <X className="size-4" />
                    </button>
                </div>
                <div className="hover-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    <div className="flex items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900">
                        {url ? <img src={url} alt={(prompt || "").slice(0, 40)} className="agent-fade-in max-h-[46vh] w-full object-contain" /> : null}
                    </div>
                    <div>
                        <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{t("chat.artifact.prompt")}</span>
                            <span className="text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{(prompt || "").length}</span>
                        </div>
                        <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 5, maxRows: 12 }} className="!rounded-xl !text-[13px] !leading-6" />
                    </div>
                    <div>
                        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{t("chat.artifact.continueTitle")}</div>
                        <div className="flex items-end gap-2">
                            <Input.TextArea
                                value={instruction}
                                onChange={(event) => setInstruction(event.target.value)}
                                placeholder={t("chat.artifact.continuePlaceholder")}
                                autoSize={{ minRows: 1, maxRows: 4 }}
                                className="!rounded-xl !text-[13px]"
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                        event.preventDefault();
                                        continueInChat();
                                    }
                                }}
                            />
                            <Button type="primary" onClick={continueInChat} className="!h-9 shrink-0">
                                {t("chat.artifact.continueAction")}
                            </Button>
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-xl border border-stone-200/80 bg-white/60 px-2 py-2 dark:border-stone-800 dark:bg-white/[.03]">
                            <div className="text-[10px] text-stone-400 dark:text-stone-500">{t("chat.artifact.model")}</div>
                            <div className="truncate font-mono text-[11px] text-stone-700 dark:text-stone-200">{artifact.model}</div>
                        </div>
                        <div className="rounded-xl border border-stone-200/80 bg-white/60 px-2 py-2 dark:border-stone-800 dark:bg-white/[.03]">
                            <div className="text-[10px] text-stone-400 dark:text-stone-500">{t("chat.artifact.size")}</div>
                            <div className="font-mono text-[11px] text-stone-700 dark:text-stone-200">
                                {artifact.width}×{artifact.height}
                            </div>
                        </div>
                        <div className="rounded-xl border border-stone-200/80 bg-white/60 px-2 py-2 dark:border-stone-800 dark:bg-white/[.03]">
                            <div className="text-[10px] text-stone-400 dark:text-stone-500">{t("chat.artifact.ratio")}</div>
                            <div className="font-mono text-[11px] text-stone-700 dark:text-stone-200">{(artifact.width / artifact.height).toFixed(2)}</div>
                        </div>
                    </div>
                </div>
                <div className="shrink-0 space-y-2 border-t border-stone-200/80 px-4 py-3 dark:border-stone-800">
                    <Button block icon={<SlidersHorizontal className="size-3.5" />} onClick={fillWorkbench}>
                        {t("chat.actions.fillWorkbench")}
                    </Button>
                    <div className="flex justify-between gap-1">
                        <Button size="small" type="text" icon={<Download className="size-3.5" />} onClick={() => void download()}>
                            {t("chat.actions.download")}
                        </Button>
                        <Button size="small" type="text" icon={<FolderPlus className="size-3.5" />} onClick={() => void saveToAssets()}>
                            {t("chat.actions.addToAssets")}
                        </Button>
                        <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(prompt)}>
                            {t("common.copyPrompt")}
                        </Button>
                    </div>
                </div>
            </aside>
        </>
    );
}
