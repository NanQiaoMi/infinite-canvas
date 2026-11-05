import { App, Button, Card, Input, InputNumber, Switch } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverApi } from "@/services/api/server";
import type { AdminQuotaPolicy, AdminQuotaLimits, ServerCapability } from "@/types/server";

import { ADMIN_CAPABILITIES, capabilityLabelKey } from "../format";

const FIELDS: Array<{ key: keyof AdminQuotaLimits; labelKey: string; hintKey: string }> = [
    { key: "daily", labelKey: "server.admin.quota.daily", hintKey: "server.admin.quota.zeroUnlimited" },
    { key: "weekly", labelKey: "server.admin.quota.weekly", hintKey: "server.admin.quota.zeroUnlimited" },
    { key: "ipDaily", labelKey: "server.admin.quota.ipDaily", hintKey: "server.admin.quota.zeroDisabled" },
    { key: "ipWeekly", labelKey: "server.admin.quota.ipWeekly", hintKey: "server.admin.quota.zeroDisabled" },
];

export function QuotaPolicyPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [policy, setPolicy] = useState<AdminQuotaPolicy | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await serverApi.admin.quotaPolicy();
            setPolicy(data.policy);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const updateLimit = (capability: ServerCapability, key: keyof AdminQuotaLimits, value: number | null) => {
        setPolicy((current) => {
            if (!current) return current;
            return {
                ...current,
                capabilities: {
                    ...current.capabilities,
                    [capability]: { ...current.capabilities[capability], [key]: Math.max(0, Math.floor(value ?? 0)) },
                },
            };
        });
    };

    const save = async () => {
        if (!policy) return;
        setSaving(true);
        try {
            const data = await serverApi.admin.saveQuotaPolicy(policy);
            setPolicy(data.policy);
            message.success(t("server.admin.quota.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t("server.admin.quota.description")}</div>
                <div className="flex gap-2">
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                        {t("server.admin.common.refresh")}
                    </Button>
                    <Button size="small" type="primary" loading={saving} onClick={() => void save()} disabled={!policy}>
                        {t("server.admin.common.save")}
                    </Button>
                </div>
            </div>
            {policy ? (
                <>
                    <Card size="small">
                        <div className="grid gap-4 md:grid-cols-3">
                            <label className="block">
                                <span className="mb-1 block text-sm font-medium">{t("server.admin.quota.timezone")}</span>
                                <Input value={policy.timezone} onChange={(event) => setPolicy({ ...policy, timezone: event.target.value })} />
                            </label>
                            <div className="flex items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800">
                                <span>{t("server.admin.quota.adminExempt")}</span>
                                <Switch checked={policy.adminExempt} onChange={(checked) => setPolicy({ ...policy, adminExempt: checked })} />
                            </div>
                            <div className="flex items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800">
                                <span>{t("server.admin.quota.refundOnFailure")}</span>
                                <Switch checked={policy.refundOnFailure} onChange={(checked) => setPolicy({ ...policy, refundOnFailure: checked })} />
                            </div>
                        </div>
                    </Card>
                    <div className="grid gap-3 md:grid-cols-2">
                        {ADMIN_CAPABILITIES.map((capability) => (
                            <Card key={capability} size="small" title={t(capabilityLabelKey(capability))}>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {FIELDS.map((field) => (
                                        <label key={field.key} className="block">
                                            <span className="mb-1 block text-xs text-stone-500">{t(field.labelKey)}</span>
                                            <InputNumber
                                                className="w-full"
                                                min={0}
                                                precision={0}
                                                value={policy.capabilities[capability][field.key]}
                                                onChange={(value) => updateLimit(capability, field.key, typeof value === "number" ? value : 0)}
                                            />
                                            <span className="mt-0.5 block text-[11px] text-stone-400">{t(field.hintKey)}</span>
                                        </label>
                                    ))}
                                </div>
                            </Card>
                        ))}
                    </div>
                    <div className="text-xs text-stone-500">{t("server.admin.quota.footer")}</div>
                </>
            ) : null}
        </div>
    );
}
