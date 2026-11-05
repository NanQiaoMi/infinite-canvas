import { Button, Checkbox, Input, Modal, Select } from "antd";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { guessCapability } from "@/stores/use-config-store";
import type { ServerCapability } from "@/types/server";

import { ADMIN_CAPABILITIES, capabilityLabelKey } from "../format";

export type ImportedModel = { name: string; capability: ServerCapability };

type DraftItem = ImportedModel & { checked: boolean };

type ModelImportModalProps = {
    open: boolean;
    /** 上游拉取到的全部模型名 */
    models: string[];
    /** 渠道里已存在的模型名（自动跳过） */
    existingNames: string[];
    onConfirm: (models: ImportedModel[]) => void;
    onClose: () => void;
};

export function ModelImportModal({ open, models, existingNames, onConfirm, onClose }: ModelImportModalProps) {
    const { t } = useTranslation();
    const [items, setItems] = useState<DraftItem[]>([]);
    const [search, setSearch] = useState("");

    useEffect(() => {
        if (!open) return;
        const existing = new Set(existingNames);
        setItems(
            models
                .filter((name) => !existing.has(name))
                .map((name) => ({ name, capability: guessCapability(name) as ServerCapability, checked: true })),
        );
        setSearch("");
    }, [open, models, existingNames]);

    const visible = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return keyword ? items.filter((item) => item.name.toLowerCase().includes(keyword)) : items;
    }, [items, search]);

    const selected = items.filter((item) => item.checked);
    const counts = useMemo(() => {
        const result = { image: 0, video: 0, text: 0, audio: 0 } as Record<ServerCapability, number>;
        for (const item of items) result[item.capability] += 1;
        return result;
    }, [items]);

    const patchItem = (name: string, patch: Partial<DraftItem>) => setItems((current) => current.map((item) => (item.name === name ? { ...item, ...patch } : item)));
    const toggleAll = (checked: boolean) => {
        const visibleNames = new Set(visible.map((item) => item.name));
        setItems((current) => current.map((item) => (visibleNames.has(item.name) ? { ...item, checked } : item)));
    };
    const bulkSet = (capability: ServerCapability) => setItems((current) => current.map((item) => (item.checked ? { ...item, capability } : item)));

    return (
        <Modal
            open={open}
            width={720}
            title={
                <div>
                    <div className="text-base font-semibold">{t("server.admin.channels.importTitle")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">
                        {t("server.admin.channels.importSummary", { count: items.length })} ·{" "}
                        {ADMIN_CAPABILITIES.map((capability) => `${t(capabilityLabelKey(capability))} ${counts[capability]}`).join(" · ")}
                    </div>
                </div>
            }
            onCancel={onClose}
            footer={
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-stone-500">{t("server.admin.channels.importSelected", { count: selected.length })}</span>
                    <div className="flex gap-2">
                        <Button onClick={onClose}>{t("server.admin.common.cancel")}</Button>
                        <Button type="primary" disabled={!selected.length} onClick={() => onConfirm(selected.map(({ name, capability }) => ({ name, capability })))}>
                            {t("server.admin.channels.importConfirm", { count: selected.length })}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        allowClear
                        size="small"
                        className="w-56"
                        prefix={<Search className="size-3.5 text-stone-400" />}
                        placeholder={t("server.admin.channels.importSearch")}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                    <Button size="small" onClick={() => toggleAll(true)}>
                        {t("server.admin.channels.importSelectAll")}
                    </Button>
                    <Button size="small" onClick={() => toggleAll(false)}>
                        {t("server.admin.channels.importClear")}
                    </Button>
                    <span className="text-xs text-stone-400">{t("server.admin.channels.importBulkSet")}</span>
                    {ADMIN_CAPABILITIES.map((capability) => (
                        <Button key={capability} size="small" onClick={() => bulkSet(capability)}>
                            {t(capabilityLabelKey(capability))}
                        </Button>
                    ))}
                </div>
                {items.length === 0 ? (
                    <div className="py-10 text-center text-sm text-stone-500">{t("server.admin.channels.importEmpty")}</div>
                ) : (
                    <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
                        {visible.map((item) => (
                            <div key={item.name} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                                <Checkbox checked={item.checked} onChange={(event) => patchItem(item.name, { checked: event.target.checked })} />
                                <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>
                                    {item.name}
                                </span>
                                <Select
                                    size="small"
                                    className="w-28"
                                    value={item.capability}
                                    options={ADMIN_CAPABILITIES.map((capability) => ({ value: capability, label: t(capabilityLabelKey(capability)) }))}
                                    onChange={(value) => patchItem(item.name, { capability: value })}
                                />
                            </div>
                        ))}
                    </div>
                )}
                <div className="text-[11px] text-stone-400">{t("server.admin.channels.importExistingHint")}</div>
            </div>
        </Modal>
    );
}
