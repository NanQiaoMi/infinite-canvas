import { App, Button, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { Download, FolderPlus, ImageIcon, LoaderCircle, Maximize2, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ensureImagePreview, getImagePreviewRevision, getImageBlob, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import type { AgentImageRef } from "@/lib/conversation-agent/types";

export function ImageResultCard({ image }: { image: AgentImageRef }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const revision = useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [preview, setPreview] = useState("");
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
            className="group cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md dark:border-stone-800 dark:hover:border-stone-700"
            onClick={() => openArtifact(image)}
            title={t("chat.artifact.open")}
        >
            <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-stone-100 dark:bg-stone-800">
                {thumb ? (
                    <img src={thumb} alt={image.prompt.slice(0, 40)} className="agent-fade-in h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" />
                ) : (
                    <LoaderCircle className="size-5 animate-spin text-stone-400" />
                )}
                <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    <Maximize2 className="size-3" />
                </span>
            </div>
            <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                <span className="min-w-0 truncate text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                    {image.width}×{image.height}
                </span>
                <div className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
                    <Tooltip title={t("chat.actions.download")}>
                        <Button size="small" type="text" icon={<Download className="size-3.5" />} onClick={() => void download()} />
                    </Tooltip>
                    <Tooltip title={t("chat.actions.addToAssets")}>
                        <Button size="small" type="text" icon={<FolderPlus className="size-3.5" />} onClick={() => void saveToAssets()} />
                    </Tooltip>
                    <Tooltip title={t("chat.actions.fillWorkbench")}>
                        <Button size="small" type="text" icon={<SlidersHorizontal className="size-3.5" />} onClick={fillWorkbench} />
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

export function ImageResultGrid({ images }: { images: AgentImageRef[] }) {
    const { t } = useTranslation();
    if (!images.length) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-400 dark:border-stone-700">
                <ImageIcon className="size-4" />
                {t("chat.tools.emptyImages")}
            </div>
        );
    }
    return (
        <div className="grid max-w-xl grid-cols-2 gap-2 sm:grid-cols-3">
            {images.map((image) => (
                <ImageResultCard key={image.id} image={image} />
            ))}
        </div>
    );
}
