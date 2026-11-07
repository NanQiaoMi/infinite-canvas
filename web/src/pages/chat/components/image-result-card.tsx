import { App, Button, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { Check, Columns2, Download, FolderPlus, ImageIcon, Layers, Maximize2, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
    const [isGif, setIsGif] = useState(false);
    const addAsset = useAssetStore((state) => state.addAsset);
    const openArtifact = useConversationAgentStore((state) => state.openArtifact);

    useEffect(() => {
        if (!image.storageKey) return;
        void ensureImagePreview(image.storageKey);
        void getImageBlob(image.storageKey).then((blob) => {
            if (blob?.type === "image/gif") setIsGif(true);
        });
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
        const blob = image.storageKey ? await getImageBlob(image.storageKey) : null;
        const ext = blob?.type === "image/gif" || image.storageKey?.endsWith(".gif") ? "gif" : "png";
        if (url) saveAs(url, `${image.id}.${ext}`);
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
    const aspect = useMemo(() => {
        if (image.width && image.height && image.width > 0 && image.height > 0) {
            return Math.min(2.5, Math.max(0.4, image.width / image.height));
        }
        return 1;
    }, [image.width, image.height]);

    return (
        <div
            className={cn(
                "group relative cursor-pointer overflow-hidden rounded-2xl shadow-xs transition-all duration-300 hover:shadow-md",
                selected && "ring-2 ring-stone-800 dark:ring-stone-200",
            )}
            style={{ aspectRatio: String(aspect) }}
            onClick={() => {
                if (selectable) {
                    onToggleSelect?.();
                } else {
                    openArtifact(image);
                }
            }}
            title={selectable ? (selected ? t("chat.compare.deselect") : t("chat.compare.select")) : t("chat.artifact.open")}
        >
            {/* 多选勾选圈 */}
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

            {/* 图片本体：保持与生成规格完全一致的画幅比例，无多余二次形变 */}
            <div
                className="relative flex h-full w-full items-center justify-center overflow-hidden bg-stone-100/60 dark:bg-stone-900/40"
                style={{ aspectRatio: String(aspect) }}
            >
                {thumb ? (
                    <img
                        src={thumb}
                        alt={image.prompt.slice(0, 40)}
                        onLoad={() => setLoaded(true)}
                        className={cn(
                            "h-full w-full object-cover transition-opacity duration-300 ease-out group-hover:scale-[1.02] agent-developing",
                            loaded ? "opacity-100" : "opacity-0",
                        )}
                    />
                ) : null}

                {/* 加载未完成时的点阵占位，比例严格一致，杜绝二次形变闪烁 */}
                {!loaded ? (
                    <div className="absolute inset-0 flex flex-col justify-between py-1 bg-transparent">
                        <div className="flex items-center justify-between pb-1 px-1">
                            <span className="agent-fade-in text-sm font-medium tracking-tight text-stone-700 dark:text-stone-300">
                                {t("chat.waiting.phaseRender")}
                            </span>
                        </div>
                        <div className="relative min-h-0 flex-1">
                            <ChatGptDotMatrix aspect={aspect} />
                        </div>
                    </div>
                ) : null}

                {/* 动图 GIF 徽章 */}
                {isGif ? (
                    <span className="pointer-events-none absolute left-2.5 top-2.5 z-10 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-white backdrop-blur-sm shadow-xs">
                        GIF
                    </span>
                ) : null}

                {/* 右上角放大预览按钮 */}
                <span className="absolute right-2 top-2 flex size-6.5 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 shadow-xs">
                    <Maximize2 className="size-3" />
                </span>

                {/* 左下角微悬浮尺寸标签（无框，仅在 hover 时优雅微显） */}
                {image.width && image.height ? (
                    <span className="absolute bottom-2.5 left-2.5 rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                        {image.width}×{image.height}
                    </span>
                ) : null}

                {/* 右下角悬浮玻璃拟态操作栏（直接悬浮在图片上，不占外部空间、不产生下挂框） */}
                <div
                    className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 rounded-full bg-black/55 px-1 py-0.5 text-white opacity-0 backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 shadow-md dark:bg-black/70"
                    onClick={(event) => event.stopPropagation()}
                >
                    <Tooltip title={t("chat.actions.download")}>
                        <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                            onClick={() => void download()}
                        >
                            <Download className="size-3.5" />
                        </button>
                    </Tooltip>
                    <Tooltip title={t("chat.actions.addToAssets")}>
                        <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                            onClick={() => void saveToAssets()}
                        >
                            <FolderPlus className="size-3.5" />
                        </button>
                    </Tooltip>
                    <Tooltip title={t("chat.actions.fillWorkbench")}>
                        <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                            onClick={fillWorkbench}
                        >
                            <SlidersHorizontal className="size-3.5" />
                        </button>
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
                            <div className="flex items-center gap-1.5">
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-6 !px-2 text-xs"
                                    onClick={() => setSelectedIds(images.map((img) => img.id))}
                                >
                                    {t("chat.compare.selectAll")}
                                </Button>
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-6 !px-2 text-xs"
                                    onClick={() => {
                                        setSelectedIds([]);
                                        setSelecting(false);
                                    }}
                                >
                                    {t("chat.compare.clearSelection")}
                                </Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    className="!h-6 !px-2.5 text-xs bg-stone-900 text-white hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900"
                                    disabled={selectedIds.length === 0}
                                    icon={<Layers className="size-3" />}
                                    onClick={() => setCompareOpen(true)}
                                >
                                    {t("chat.actions.useAsReference")} ({selectedIds.length})
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <span className="font-medium text-[11px] text-stone-400 dark:text-stone-500">
                                {t("chat.tools.resultImages", { count: images.length, size: `${images[0]?.width || 1024}×${images[0]?.height || 1024}` })}
                            </span>
                            <div className="flex items-center gap-1.5">
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-6 !px-2 text-xs text-stone-600 dark:text-stone-300"
                                    icon={<Columns2 className="size-3" />}
                                    onClick={() => {
                                        setSelecting(true);
                                        setSelectedIds(images.map((img) => img.id));
                                    }}
                                >
                                    {t("chat.compare.selectImages")}
                                </Button>
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-6 !px-2 text-xs text-stone-600 dark:text-stone-300"
                                    icon={<Layers className="size-3" />}
                                    onClick={() => setCompareOpen(true)}
                                >
                                    {t("chat.compare.sideBySide")}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            ) : null}

            <div
                className="grid gap-3"
                style={{
                    gridTemplateColumns: images.length === 1 ? "minmax(0, 420px)" : "repeat(2, minmax(0, 1fr))",
                }}
            >
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

            {compareOpen ? (
                <ImageCompareModal
                    open={compareOpen}
                    onClose={() => setCompareOpen(false)}
                    images={compareImages}
                    onBatchReference={handleBatchReference}
                />
            ) : null}
        </div>
    );
}
