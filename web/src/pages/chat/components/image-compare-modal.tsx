import { App, Button, Modal, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { Copy, Download, Layers, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import type { AgentImageRef } from "@/lib/conversation-agent/types";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { cn } from "@/lib/utils";

type ImageCompareModalProps = {
    open: boolean;
    images: AgentImageRef[];
    onClose: () => void;
    onBatchReference?: (images: AgentImageRef[]) => void;
};

function CompareCard({
    image,
    index,
    onUseReference,
}: {
    image: AgentImageRef;
    index: number;
    onUseReference: (image: AgentImageRef) => void;
}) {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const revision = useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [fullUrl, setFullUrl] = useState("");

    useEffect(() => {
        if (!image.storageKey) return;
        void ensureImagePreview(image.storageKey);
    }, [image.storageKey]);

    useEffect(() => {
        let active = true;
        void resolveImageUrl(image.storageKey).then((url) => {
            if (active) setFullUrl(url);
        });
        return () => {
            active = false;
        };
    }, [image.storageKey, revision]);

    const thumb = previewUrlFor(image.storageKey) || fullUrl;

    const download = async () => {
        const url = await resolveImageUrl(image.storageKey);
        if (url) saveAs(url, `${image.id || `image-${index + 1}`}.png`);
    };

    const ratio = image.width && image.height ? (image.width / image.height).toFixed(2) : "-";

    return (
        <div className="flex flex-col overflow-hidden rounded-2xl border border-stone-200/90 bg-white/70 shadow-sm transition dark:border-stone-800 dark:bg-stone-900/60">
            {/* 卡片头部 */}
            <div className="flex h-9 items-center justify-between border-b border-stone-200/70 px-3 dark:border-stone-800">
                <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-stone-600 dark:text-stone-300">
                    <span className="flex size-4 items-center justify-center rounded-full bg-stone-200/80 text-[10px] font-bold dark:bg-stone-800">
                        {index + 1}
                    </span>
                    {image.model || t("chat.artifact.imageTitle", { index: index + 1 })}
                </span>
                <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
                    {image.width}×{image.height}
                </span>
            </div>

            {/* 大图预览区域 */}
            <div className="relative flex aspect-square max-h-[46vh] items-center justify-center overflow-hidden bg-stone-100/70 dark:bg-stone-950/40">
                {thumb ? (
                    <img
                        src={thumb}
                        alt={image.prompt.slice(0, 30)}
                        className="h-full w-full object-contain transition-transform duration-300"
                    />
                ) : (
                    <LoaderCircle className="size-6 animate-spin text-stone-400" />
                )}
            </div>

            {/* 属性与提示词 */}
            <div className="flex flex-1 flex-col justify-between gap-3 p-3">
                <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-1.5 text-center text-[11px]">
                        <div className="rounded-lg border border-stone-200/60 bg-stone-50/70 px-2 py-1 dark:border-stone-800 dark:bg-stone-900/40">
                            <div className="text-[10px] text-stone-400">{t("chat.artifact.size")}</div>
                            <div className="font-mono text-stone-700 dark:text-stone-200">
                                {image.width}×{image.height}
                            </div>
                        </div>
                        <div className="rounded-lg border border-stone-200/60 bg-stone-50/70 px-2 py-1 dark:border-stone-800 dark:bg-stone-900/40">
                            <div className="text-[10px] text-stone-400">{t("chat.artifact.ratio")}</div>
                            <div className="font-mono text-stone-700 dark:text-stone-200">{ratio}</div>
                        </div>
                    </div>

                    {image.prompt ? (
                        <div className="relative rounded-xl border border-stone-200/70 bg-stone-50/50 p-2 dark:border-stone-800/80 dark:bg-stone-900/30">
                            <div className="mb-1 flex items-center justify-between text-[10px] text-stone-400">
                                <span>{t("chat.artifact.prompt")}</span>
                                <Tooltip title={t("common.copyPrompt")}>
                                    <button
                                        type="button"
                                        className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
                                        onClick={() => copyText(image.prompt)}
                                    >
                                        <Copy className="size-3" />
                                    </button>
                                </Tooltip>
                            </div>
                            <p className="line-clamp-3 text-xs leading-5 text-stone-600 dark:text-stone-300">
                                {image.prompt}
                            </p>
                        </div>
                    ) : null}
                </div>

                {/* 卡片独立操作 */}
                <div className="flex items-center justify-between gap-1 border-t border-stone-100 pt-2 dark:border-stone-800/60">
                    <Button size="small" type="text" icon={<Download className="size-3.5" />} onClick={() => void download()}>
                        {t("chat.actions.download")}
                    </Button>
                    <Button size="small" type="text" icon={<Layers className="size-3.5" />} onClick={() => onUseReference(image)}>
                        {t("chat.compare.useAsReference")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export function ImageCompareModal({ open, images, onClose, onBatchReference }: ImageCompareModalProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();

    if (!images.length) return null;

    const downloadAll = async () => {
        for (let i = 0; i < images.length; i += 1) {
            const img = images[i];
            const url = await resolveImageUrl(img.storageKey);
            if (url) {
                saveAs(url, `${img.id || `compare-${i + 1}`}.png`);
            }
        }
        message.success(t("chat.compare.downloadAllSuccess", { count: images.length }));
    };

    const handleSingleReference = (image: AgentImageRef) => {
        onBatchReference?.([image]);
        message.success(t("chat.actions.batchReferenceAdded", { count: 1 }));
    };

    const handleBatchReference = () => {
        onBatchReference?.(images);
        message.success(t("chat.actions.batchReferenceAdded", { count: images.length }));
        onClose();
    };

    const colCount = Math.min(images.length, 4);

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width="92vw"
            style={{ maxWidth: 1280, top: 32 }}
            styles={{
                container: {
                    padding: 0,
                    borderRadius: 20,
                    overflow: "hidden",
                    backgroundColor: "transparent",
                    boxShadow: "none",
                },
            }}
            destroyOnClose
        >
            <div className="flex flex-col rounded-2xl border border-stone-200 bg-[#faf9f5] shadow-2xl dark:border-stone-800 dark:bg-[#1c1b19]">
                {/* 弹窗顶部栏 */}
                <div className="flex h-14 shrink-0 items-center justify-between border-b border-stone-200/80 px-5 dark:border-stone-800">
                    <div className="flex items-center gap-2.5">
                        <span className="text-base font-semibold text-stone-900 dark:text-stone-100">
                            {t("chat.compare.title")}
                        </span>
                        <span className="rounded-full bg-stone-200/70 px-2 py-0.5 text-xs font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                            {t("chat.compare.count", { count: images.length })}
                        </span>
                    </div>
                    <button
                        type="button"
                        className="flex size-8 items-center justify-center rounded-full text-stone-500 transition hover:bg-black/[.05] dark:text-stone-400 dark:hover:bg-white/[.08]"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                    </button>
                </div>

                {/* 核心对比并排网格 */}
                <div className="hover-scrollbar max-h-[75vh] overflow-y-auto p-5">
                    <div
                        className={cn(
                            "grid gap-4",
                            colCount === 2 && "grid-cols-1 sm:grid-cols-2",
                            colCount === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
                            colCount >= 4 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
                        )}
                    >
                        {images.map((image, index) => (
                            <CompareCard
                                key={image.id || index}
                                image={image}
                                index={index}
                                onUseReference={handleSingleReference}
                            />
                        ))}
                    </div>
                </div>

                {/* 底部操作条 */}
                <div className="flex shrink-0 items-center justify-between border-t border-stone-200/80 px-5 py-3 dark:border-stone-800">
                    <Button size="middle" icon={<Download className="size-4" />} onClick={() => void downloadAll()}>
                        {t("chat.compare.downloadAll")}
                    </Button>
                    <div className="flex items-center gap-2">
                        <Button onClick={onClose}>{t("common.close")}</Button>
                        <Button type="primary" icon={<Layers className="size-4" />} onClick={handleBatchReference}>
                            {t("chat.actions.batchReferenceCount", { count: images.length })}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
