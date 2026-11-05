import { App, Button, Image, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { Download, FolderPlus, ImageIcon, LoaderCircle, Pencil, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ensureImagePreview, getImagePreviewRevision, getImageBlob, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { AgentImageRef } from "@/lib/conversation-agent/types";

export function ImageResultCard({ image, onUseAsReference }: { image: AgentImageRef; onUseAsReference?: (image: AgentImageRef) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const revision = useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [preview, setPreview] = useState("");
    const addAsset = useAssetStore((state) => state.addAsset);

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
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="relative flex aspect-square items-center justify-center bg-stone-100 dark:bg-stone-800">
                {thumb ? (
                    <Image src={thumb} alt={image.prompt.slice(0, 40)} className="!h-full !w-full object-cover" />
                ) : (
                    <LoaderCircle className="size-5 animate-spin text-stone-400" />
                )}
            </div>
            <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                <span className="min-w-0 truncate text-[11px] text-stone-400">
                    {image.model} · {image.width}×{image.height}
                </span>
                <div className="flex shrink-0 items-center">
                    <Tooltip title={t("chat.actions.download")}>
                        <Button size="small" type="text" icon={<Download className="size-3.5" />} onClick={() => void download()} />
                    </Tooltip>
                    <Tooltip title={t("chat.actions.addToAssets")}>
                        <Button size="small" type="text" icon={<FolderPlus className="size-3.5" />} onClick={() => void saveToAssets()} />
                    </Tooltip>
                    <Tooltip title={t("chat.actions.fillWorkbench")}>
                        <Button size="small" type="text" icon={<SlidersHorizontal className="size-3.5" />} onClick={fillWorkbench} />
                    </Tooltip>
                    {onUseAsReference ? (
                        <Tooltip title={t("chat.actions.useAsReference")}>
                            <Button size="small" type="text" icon={<Pencil className="size-3.5" />} onClick={() => onUseAsReference(image)} />
                        </Tooltip>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

export function ImageResultGrid({ images, onUseAsReference }: { images: AgentImageRef[]; onUseAsReference?: (image: AgentImageRef) => void }) {
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
                <ImageResultCard key={image.id} image={image} onUseAsReference={onUseAsReference} />
            ))}
        </div>
    );
}
