import { App, Button, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { Check, Columns2, Download, FolderPlus, ImageIcon, Layers, Maximize2, SlidersHorizontal, Sparkles } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ensureImagePreview, getImagePreviewRevision, getImageBlob, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import type { AgentImageRef } from "@/lib/conversation-agent/types";
import { cn } from "@/lib/utils";

import { ImageCompareModal } from "./image-compare-modal";
import { ChatGptDotMatrix } from "./chatgpt-dot-matrix";

export function ImageResultCard({
    image,
    selectable,
    selected,
    onToggleSelect,
}: {
    image: AgentImageRef;
    selectable?: boolean;
    selected?: boolean;
    onToggleSelect?: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const revision = useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [preview, setPreview] = useState("");
    const [loaded, setLoaded] = useState(false);
    const addAsset = useAssetStore((state) => state.addAsset);
    const openArtifact = useConversationAgentStore((state) => state.openArtifact);

    useEffect(() => {
        if (!image.storageKey) return;
        void ensureImagePreview(image.storageKey);
    }, [image.storageKey]);

    useEffect(() => {
        let active = true;
        void resolveImageUrl(image.storageKey).then((url) => {
            if (active) setPreview(url);
        });
        return () => {
            active = false;
        };
    }, [image.storageKey, revision]);

    const download = async () => {
        const url = await resolveImageUrl(image.storageKey);
        if (url) saveAs(url, `${image.id}.png`);
    };

    const saveToAssets = async () => {
        if (!image.storageKey) return;
        const url = await resolveImageUrl(image.storageKey);
        const blob = await getImageBlob(image.storageKey);
        addAsset({
            kind: "image",
            title: image.prompt.slice(0, 24) || image.id,
            coverUrl: "",
            tags: [],
            source: "conversation-agent",
            data: { dataUrl: url, storageKey: image.storageKey, width: image.width || 0, height: image.height || 0, bytes: blob?.size || 0, mimeType: blob?.type || "image/png" },
        });
        message.success(t("chat.actions.assetAdded"));
    };

    const fillWorkbench = () => {
        useWorkbenchAgentStore.getState().dispatchImage({ prompt: image.prompt, run: false });
        message.success(t("chat.actions.filledWorkbench"));
    };

    const thumb = previewUrlFor(image.storageKey) || preview;

    return (
        <div
            className={cn(
                "group relative cursor-pointer overflow-hidden rounded-2xl border transition-all duration-300",
                selected
                    ? "border-stone-800 ring-2 ring-stone-800/80 shadow-md dark:border-stone-200 dark:ring-stone-200/80"
                    : "border-stone-200/90 bg-white/70 shadow-xs hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md dark:border-stone-800 dark:bg-stone-900/50 dark:hover:border-stone-700",
            )}
            onClick={() => {
                if (selectable) {
                    onToggleSelect?.();
                } else {
                    openArtifact(image);
                }
            }}
            title={selectable ? (selected ? t("chat.compare.deselect") : t("chat.compare.select")) : t("chat.artifact.open")}
        >
            {/* 多选圈 */}
            {selectable || selected ? (
                <button
                    type="button"
                    className={cn(
                        "absolute left-2.5 top-2.5 z-10 flex size-5.5 items-center justify-center rounded-full transition-transform shadow-xs",
                        selected
                            ? "bg-stone-900 text-white shadow dark:bg-white dark:text-stone-900"
                            : "border border-black/30 bg-white/80 text-transparent backdrop-blur-sm hover:border-black/60 dark:border-white/40 dark:bg-black/60",
                    )}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleSelect?.();
                    }}
                >
                    <Check className="size-3.5 stroke-[3]" />
                </button>
            ) : (
                <button
                    type="button"
                    className="absolute left-2.5 top-2.5 z-10 hidden size-5.5 items-center justify-center rounded-full border border-black/30 bg-white/80 text-transparent opacity-0 backdrop-blur-sm transition hover:border-black/60 group-hover:flex group-hover:opacity-100 dark:border-white/40 dark:bg-black/60"
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleSelect?.();
                    }}
                >
                    <Check className="size-3.5 stroke-[3]" />
                </button>
            )}

            <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-stone-100/80 dark:bg-stone-950/40">
                {thumb ? (
                    <img
                        src={thumb}
                        alt={image.prompt.slice(0, 40)}
                        onLoad={() => setLoaded(true)}
                        className={cn(
                            "h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]",
                            loaded ? "agent-developing" : "opacity-0 scale-[0.97] blur-lg",
                        )}
                    />
                ) : null}

                {/* 显现瞬间的掠影高光（ChatGPT DALL-E 标志性光泽扫掠动效） */}
                {loaded ? (
                    <div className="agent-shine-sweep pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/20" />
                ) : null}

                {!loaded ? (
                    <div className="absolute inset-0 flex flex-col justify-between p-3.5 bg-white dark:bg-stone-900">
                        <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400">
                            {t("chat.waiting.phaseRender")}
                        </span>
                        <div className="relative min-h-0 flex-1">
                            <ChatGptDotMatrix aspect={1} />
                        </div>
                    </div>
                ) : null}
                <span className="absolute right-2 top-2 flex size-6.5 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 shadow-xs">
                    <Maximize2 className="size-3" />
                </span>
            </div>
            <div className="flex items-center justify-between gap-1 px-2.5 py-1.5 border-t border-stone-100 dark:border-stone-800/60">
                <span className="min-w-0 truncate font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                    {image.width}×{image.height}
                </span>
                <div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
                    <Tooltip title={t("chat.actions.download")}>
                        <Button size="small" type="text" className="!size-7 !p-0" icon={<Download className="size-3.5" />} onClick={() => void download()} />
                    </Tooltip>
                    <Tooltip title={t("chat.actions.addToAssets")}>
                        <Button size="small" type="text" className="!size-7 !p-0" icon={<FolderPlus className="size-3.5" />} onClick={() => void saveToAssets()} />
                    </Tooltip>
                    <Tooltip title={t("chat.actions.fillWorkbench")}>
                        <Button size="small" type="text" className="!size-7 !p-0" icon={<SlidersHorizontal className="size-3.5" />} onClick={fillWorkbench} />
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

export function ImageResultGrid({ images }: { images: AgentImageRef[] }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [selecting, setSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [compareOpen, setCompareOpen] = useState(false);

    const requestReferences = useConversationAgentStore((state) => state.requestReferences);

    if (!images.length) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-400 dark:border-stone-700">
                <ImageIcon className="size-4" />
                {t("chat.tools.emptyImages")}
            </div>
        );
    }

    const toggleSelect = (id: string) => {
        setSelecting(true);
        setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    };

    const handleBatchReference = () => {
        const toAdd = images.filter((img) => selectedIds.includes(img.id));
        if (!toAdd.length) return;
        requestReferences(toAdd);
        message.success(t("chat.actions.batchReferenceAdded", { count: toAdd.length }));
        setSelecting(false);
        setSelectedIds([]);
    };

    const selectedImages = images.filter((img) => selectedIds.includes(img.id));
    const compareImages = selectedImages.length >= 2 ? selectedImages : images;

    return (
        <div className="max-w-xl">
            {images.length >= 2 ? (
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400">
                    {selecting ? (
                        <>
                            <span className="font-medium text-[11px]">
                                {t("chat.compare.selectedCount", { count: selectedIds.length, total: images.length })}
                            </span>
                            <div className="flex items-center gap-1">
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-6 !px-1.5 !text-[11px]"
                                    onClick={() => {
                                        if (selectedIds.length === images.length) setSelectedIds([]);
                                        else setSelectedIds(images.map((img) => img.id));
                                    }}
                                >
                                    {selectedIds.length === images.length ? t("chat.compare.clearSelection") : t("chat.compare.selectAll")}
                                </Button>
                                <Button
                                    size="small"
                                    type="default"
                                    className="!h-6 !px-2 !text-[11px]"
                                    disabled={selectedIds.length < 2}
                                    icon={<Columns2 className="size-3" />}
                                    onClick={() => setCompareOpen(true)}
                                >
                                    {t("chat.compare.sideBySide")}
                                </Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    className="!h-6 !px-2 !text-[11px]"
                                    disabled={selectedIds.length === 0}
                                    icon={<Layers className="size-3" />}
                                    onClick={handleBatchReference}
                                >
                                    {t("chat.actions.batchReference")}
                                </Button>
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-6 !px-1.5 !text-[11px]"
                                    onClick={() => {
                                        setSelecting(false);
                                        setSelectedIds([]);
                                    }}
                                >
                                    {t("common.cancel")}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <div className="ml-auto flex items-center gap-1">
                            <Button
                                size="small"
                                type="text"
                                className="!h-6 !px-1.5 !text-[11px] text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
                                icon={<Columns2 className="size-3" />}
                                onClick={() => {
                                    setSelecting(true);
                                    setSelectedIds(images.map((img) => img.id));
                                }}
                            >
                                {t("chat.compare.selectImages")}
                            </Button>
                        </div>
                    )}
                </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {images.map((image) => (
                    <ImageResultCard
                        key={image.id}
                        image={image}
                        selectable={selecting}
                        selected={selectedIds.includes(image.id)}
                        onToggleSelect={() => toggleSelect(image.id)}
                    />
                ))}
            </div>

            <ImageCompareModal
                open={compareOpen}
                images={compareImages}
                onClose={() => setCompareOpen(false)}
                onBatchReference={(batch) => {
                    requestReferences(batch);
                    setSelecting(false);
                    setSelectedIds([]);
                }}
            />
        </div>
    );
}
