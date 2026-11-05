import { App, Button, Drawer, Input, Popconfirm, Select, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { CloudDownload, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelScriptEditor } from "@/components/layout/model-script-editor";
import { serverApi } from "@/services/api/server";
import { guessCapability } from "@/stores/use-config-store";
import type { AdminChannel, AdminChannelInput, ServerApiFormat, ServerCapability } from "@/types/server";

import { ADMIN_CAPABILITIES, capabilityLabelKey } from "../format";
import { ModelImportModal, type ImportedModel } from "./model-import-modal";

type DraftModel = { name: string; capability: ServerCapability; script?: string };

type DraftChannel = {
    /** 空字符串表示新增渠道 */
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ServerApiFormat;
    enabled: boolean;
    apiKey: string;
    models: DraftModel[];
};

const API_FORMAT_OPTIONS: Array<{ value: ServerApiFormat; label: string }> = [
    { value: "openai", label: "OpenAI" },
    { value: "gemini", label: "Gemini" },
];

function emptyDraft(): DraftChannel {
    return { id: "", name: "", baseUrl: "", apiFormat: "openai", enabled: true, apiKey: "", models: [] };
}

export function ChannelsPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [channels, setChannels] = useState<AdminChannel[]>([]);
    const [defaultModels, setDefaultModels] = useState<Record<ServerCapability, string>>({ image: "", video: "", text: "", audio: "" });
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [draft, setDraft] = useState<DraftChannel | null>(null);
    const [fetchingModels, setFetchingModels] = useState(false);
    const [fetchedModels, setFetchedModels] = useState<string[]>([]);
    const [importOpen, setImportOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<{ index: number } | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await serverApi.admin.channels();
            setChannels(data.channels);
            setDefaultModels(data.defaultModels);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const openCreate = () => setDraft(emptyDraft());

    const openEdit = (channel: AdminChannel) => {
        setDraft({
            id: channel.id,
            name: channel.name,
            baseUrl: channel.baseUrl,
            apiFormat: channel.apiFormat,
            enabled: channel.enabled,
            apiKey: "",
            models: channel.models.map((model) => ({ name: model.name, capability: model.capability, script: model.script })),
        });
    };

    const patchDraft = (patch: Partial<DraftChannel>) => setDraft((current) => (current ? { ...current, ...patch } : current));

    const persist = async (nextChannels: AdminChannel[], nextDefaults = defaultModels, keyOverride?: { id: string; apiKey: string }) => {
        setSaving(true);
        try {
            const inputs: AdminChannelInput[] = nextChannels.map((channel) => ({
                id: channel.id.startsWith("pending-") ? undefined : channel.id,
                name: channel.name,
                baseUrl: channel.baseUrl,
                apiFormat: channel.apiFormat,
                enabled: channel.enabled,
                models: channel.models.map((model) => ({ name: model.name, capability: model.capability, script: model.script })),
                apiKey: keyOverride && channel.id === keyOverride.id ? keyOverride.apiKey : channel.id === draft?.id ? draft.apiKey : "",
            }));
            const response = await serverApi.admin.saveChannels(inputs, nextDefaults);
            setChannels(response.channels);
            setDefaultModels(response.defaultModels);
            setDraft(null);
            message.success(t("server.admin.channels.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setSaving(false);
        }
    };

    const saveDraft = async () => {
        if (!draft) return;
        if (!draft.baseUrl.trim()) {
            message.error(t("server.admin.channels.baseUrl"));
            return;
        }
        if (!draft.id && !draft.apiKey.trim()) {
            message.error(t("server.admin.channels.apiKey"));
            return;
        }
        const pendingId = `pending-${Date.now()}`;
        const nextChannel: AdminChannel = {
            id: draft.id || pendingId,
            name: draft.name.trim() || draft.baseUrl,
            baseUrl: draft.baseUrl.trim(),
            apiFormat: draft.apiFormat,
            enabled: draft.enabled,
            apiKeyMasked: "",
            hasApiKey: Boolean(draft.apiKey),
            models: draft.models.filter((model) => model.name.trim()).map((model) => ({ name: model.name.trim(), capability: model.capability, script: model.script })),
        };
        const nextChannels = draft.id ? channels.map((channel) => (channel.id === draft.id ? nextChannel : channel)) : [...channels, nextChannel];
        await persist(nextChannels, defaultModels, draft.id ? undefined : { id: pendingId, apiKey: draft.apiKey });
    };

    const removeChannel = (id: string) => {
        void persist(channels.filter((channel) => channel.id !== id));
    };

    const toggleEnabled = (channel: AdminChannel, enabled: boolean) => {
        void persist(channels.map((item) => (item.id === channel.id ? { ...item, enabled } : item)));
    };

    const fetchModels = async () => {
        if (!draft) return;
        setFetchingModels(true);
        try {
            const data = await serverApi.admin.testChannel({
                baseUrl: draft.baseUrl,
                apiKey: draft.apiKey || undefined,
                apiFormat: draft.apiFormat,
                channelId: draft.id && !draft.id.startsWith("pending-") ? draft.id : undefined,
            });
            if (!data.models.length) {
                message.warning(t("server.admin.channels.fetchedEmpty"));
                return;
            }
            const existing = new Set(draft.models.map((model) => model.name));
            const candidates = data.models.filter((name) => !existing.has(name));
            if (!candidates.length) {
                message.info(t("server.admin.channels.fetchedAll"));
                return;
            }
            setFetchedModels(candidates);
            setImportOpen(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setFetchingModels(false);
        }
    };

    const updateDraftModel = (index: number, patch: Partial<DraftModel>) => {
        if (!draft) return;
        patchDraft({ models: draft.models.map((model, itemIndex) => (itemIndex === index ? { ...model, ...patch } : model)) });
    };

    const addDraftModel = () => {
        if (!draft) return;
        patchDraft({ models: [...draft.models, { name: "", capability: "image" }] });
    };

    const removeDraftModel = (index: number) => {
        if (!draft) return;
        patchDraft({ models: draft.models.filter((_, itemIndex) => itemIndex !== index) });
    };

    const columns: TableColumnsType<AdminChannel> = [
        {
            title: t("server.admin.channels.name"),
            dataIndex: "name",
            render: (value: string, channel) => (
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{value}</div>
                    <div className="truncate text-xs text-stone-500">{channel.baseUrl}</div>
                </div>
            ),
        },
        { title: t("server.admin.channels.protocol"), dataIndex: "apiFormat", width: 100, render: (value: ServerApiFormat) => <Tag>{value === "gemini" ? "Gemini" : "OpenAI"}</Tag> },
        {
            title: t("server.admin.channels.models"),
            dataIndex: "models",
            width: 150,
            render: (models: AdminChannel["models"]) => {
                const counts = { image: 0, video: 0, text: 0, audio: 0 } as Record<ServerCapability, number>;
                for (const model of models) counts[model.capability] += 1;
                return (
                    <div className="text-xs">
                        <div>{models.length}</div>
                        <div className="text-stone-400">{ADMIN_CAPABILITIES.filter((capability) => counts[capability] > 0).map((capability) => `${t(capabilityLabelKey(capability))} ${counts[capability]}`).join(" · ") || "-"}</div>
                    </div>
                );
            },
        },
        {
            title: "API Key",
            dataIndex: "apiKeyMasked",
            width: 160,
            render: (value: string, channel) => <span className="text-xs text-stone-500">{channel.hasApiKey ? value || "****" : "-"}</span>,
        },
        {
            title: t("server.admin.channels.enabled"),
            dataIndex: "enabled",
            width: 90,
            render: (value: boolean, channel) => <Switch size="small" checked={value} onChange={(checked) => toggleEnabled(channel, checked)} />,
        },
        {
            title: t("server.admin.common.actions"),
            key: "actions",
            width: 140,
            render: (_value, channel) => (
                <Space size={4}>
                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(channel)} />
                    <Popconfirm title={t("server.admin.channels.deleteConfirm")} onConfirm={() => removeChannel(channel.id)}>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    const modelOptionsByCapability = useMemo(() => {
        const result = { image: [], video: [], text: [], audio: [] } as Record<ServerCapability, Array<{ value: string; label: string }>>;
        for (const channel of channels) {
            for (const model of channel.models) {
                result[model.capability].push({ value: `${channel.id}::${model.name}`, label: `${model.name}（${channel.name}）` });
            }
        }
        return result;
    }, [channels]);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t("server.admin.channels.description")}</div>
                <Button type="primary" size="small" icon={<Plus className="size-4" />} onClick={openCreate}>
                    {t("server.admin.channels.add")}
                </Button>
            </div>
            <Table<AdminChannel> size="small" rowKey="id" loading={loading || saving} pagination={false} columns={columns} dataSource={channels} />
            <div>
                <div className="mb-2 text-sm font-semibold">{t("server.admin.channels.defaultModels")}</div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {ADMIN_CAPABILITIES.map((capability) => (
                        <label key={capability} className="block">
                            <span className="mb-1 block text-xs text-stone-500">{t(capabilityLabelKey(capability))}</span>
                            <Select
                                className="w-full"
                                value={modelOptionsByCapability[capability].some((option) => option.value === defaultModels[capability]) ? defaultModels[capability] : undefined}
                                placeholder={t("server.admin.channels.defaultModelsEmpty")}
                                options={modelOptionsByCapability[capability]}
                                onChange={(value) => {
                                    const next = { ...defaultModels, [capability]: value };
                                    setDefaultModels(next);
                                    void persist(channels, next);
                                }}
                            />
                        </label>
                    ))}
                </div>
            </div>

            <Drawer
                open={Boolean(draft)}
                width={720}
                title={draft?.id ? t("server.admin.channels.editTitle") : t("server.admin.channels.createTitle")}
                onClose={() => setDraft(null)}
                extra={
                    <Space>
                        <Button onClick={() => setDraft(null)}>{t("server.admin.common.cancel")}</Button>
                        <Button type="primary" loading={saving} onClick={() => void saveDraft()}>
                            {t("server.admin.common.save")}
                        </Button>
                    </Space>
                }
            >
                {draft ? (
                    <div className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-2">
                            <label className="block">
                                <span className="mb-1 block text-sm font-medium">{t("server.admin.channels.name")}</span>
                                <Input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-sm font-medium">{t("server.admin.channels.protocol")}</span>
                                <Select className="w-full" value={draft.apiFormat} options={API_FORMAT_OPTIONS} onChange={(value) => patchDraft({ apiFormat: value })} />
                            </label>
                            <label className="block md:col-span-2">
                                <span className="mb-1 block text-sm font-medium">{t("server.admin.channels.baseUrl")}</span>
                                <Input value={draft.baseUrl} placeholder="http://host.docker.internal:3000" onChange={(event) => patchDraft({ baseUrl: event.target.value })} />
                                <span className="mt-1 block text-[11px] text-stone-400">{t("server.admin.channels.baseUrlHint")}</span>
                            </label>
                            <label className="block md:col-span-2">
                                <span className="mb-1 block text-sm font-medium">{t("server.admin.channels.apiKey")}</span>
                                <Input.Password value={draft.apiKey} placeholder={t("server.admin.channels.apiKeyPlaceholder")} onChange={(event) => patchDraft({ apiKey: event.target.value })} />
                            </label>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <div>
                                <div className="text-sm font-semibold">{t("server.admin.channels.models")}</div>
                                <div className="text-xs text-stone-500">{t("server.admin.channels.modelsCount", { count: draft.models.length })}</div>
                            </div>
                            <Space>
                                <Button size="small" icon={<CloudDownload className="size-3.5" />} loading={fetchingModels} onClick={() => void fetchModels()}>
                                    {t("server.admin.channels.fetchModels")}
                                </Button>
                                <Popconfirm
                                    title={t("server.admin.channels.redetectConfirm")}
                                    onConfirm={() => {
                                        if (!draft) return;
                                        patchDraft({ models: draft.models.map((model) => ({ ...model, capability: guessCapability(model.name) as ServerCapability })) });
                                        message.success(t("server.admin.channels.redetected"));
                                    }}
                                >
                                    <Button size="small">{t("server.admin.channels.redetect")}</Button>
                                </Popconfirm>
                                <Button size="small" icon={<Plus className="size-3.5" />} onClick={addDraftModel}>
                                    {t("server.admin.channels.addModel")}
                                </Button>
                            </Space>
                        </div>
                        <div className="space-y-2">
                            {draft.models.map((model, index) => (
                                <div key={`${index}-${model.name}`} className="flex flex-wrap items-center gap-2 rounded-md border border-stone-200 px-2 py-1.5 dark:border-stone-800">
                                    <Input className="min-w-[160px] flex-1" size="small" value={model.name} placeholder={t("server.admin.channels.modelName")} onChange={(event) => updateDraftModel(index, { name: event.target.value })} />
                                    <Select
                                        size="small"
                                        className="w-28"
                                        value={model.capability}
                                        options={ADMIN_CAPABILITIES.map((capability) => ({ value: capability, label: t(capabilityLabelKey(capability)) }))}
                                        onChange={(value) => updateDraftModel(index, { capability: value })}
                                    />
                                    <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ index })}>
                                        {t(model.script ? "server.admin.channels.scriptReady" : "server.admin.channels.script")}
                                    </Button>
                                    <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeDraftModel(index)} />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </Drawer>

            <ModelImportModal
                open={importOpen}
                models={fetchedModels}
                existingNames={draft ? draft.models.map((model) => model.name) : []}
                onClose={() => setImportOpen(false)}
                onConfirm={(imported: ImportedModel[]) => {
                    if (!draft) return;
                    patchDraft({ models: [...draft.models, ...imported] });
                    setImportOpen(false);
                    message.success(t("server.admin.channels.imported", { count: imported.length }));
                }}
            />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget && draft ? draft.models[scriptTarget.index]?.capability || "text" : "text"}
                modelName={scriptTarget && draft ? draft.models[scriptTarget.index]?.name || "" : ""}
                value={scriptTarget && draft ? draft.models[scriptTarget.index]?.script || "" : ""}
                onSave={(script) => {
                    if (!scriptTarget) return;
                    updateDraftModel(scriptTarget.index, { script: script || undefined });
                    setScriptTarget(null);
                }}
                onClose={() => setScriptTarget(null)}
            />
        </div>
    );
}
