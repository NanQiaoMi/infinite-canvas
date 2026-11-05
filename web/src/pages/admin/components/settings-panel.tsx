import { App, Button, Card, Input, InputNumber, Popconfirm, Switch } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverApi } from "@/services/api/server";
import type { AdminSettingsResponse, PublicSettings } from "@/types/server";

import { formatUptime } from "../format";

export function SettingsPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [data, setData] = useState<AdminSettingsResponse | null>(null);
    const [publicSettings, setPublicSettings] = useState<PublicSettings>({ allowModelSelection: true, announcement: "" });
    const [retentionDays, setRetentionDays] = useState(90);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [oldPassword, setOldPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changingPassword, setChangingPassword] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const response = await serverApi.admin.settings();
            setData(response);
            setPublicSettings(response.publicSettings);
            setRetentionDays(response.systemSettings.retentionDays);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const save = async () => {
        setSaving(true);
        try {
            const response = await serverApi.admin.saveSettings({
                publicSettings,
                systemSettings: { retentionDays },
            });
            setPublicSettings(response.publicSettings);
            setRetentionDays(response.systemSettings.retentionDays);
            message.success(t("server.admin.settings.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setSaving(false);
        }
    };

    const changePassword = async () => {
        if (newPassword.length < 8) {
            message.error(t("server.admin.settings.weakPassword"));
            return;
        }
        if (newPassword !== confirmPassword) {
            message.error(t("server.admin.settings.passwordMismatch"));
            return;
        }
        setChangingPassword(true);
        try {
            await serverApi.admin.changePassword(oldPassword, newPassword);
            setOldPassword("");
            setNewPassword("");
            setConfirmPassword("");
            message.success(t("server.admin.settings.passwordChanged"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setChangingPassword(false);
        }
    };

    const resetAll = async () => {
        try {
            const response = await serverApi.admin.resetAllQuota("all");
            message.success(t("server.admin.settings.resetAllDone", { count: response.changes }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t("server.admin.settings.description")}</div>
                <div className="flex gap-2">
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                        {t("server.admin.common.refresh")}
                    </Button>
                    <Button size="small" type="primary" loading={saving} onClick={() => void save()}>
                        {t("server.admin.common.save")}
                    </Button>
                </div>
            </div>
            <Card size="small" title={t("server.admin.settings.publicTitle")}>
                <div className="space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t("server.admin.settings.announcement")}</span>
                        <Input.TextArea rows={3} value={publicSettings.announcement} placeholder={t("server.admin.settings.announcementPlaceholder")} onChange={(event) => setPublicSettings({ ...publicSettings, announcement: event.target.value })} />
                    </label>
                    <div className="flex items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800">
                        <div>
                            <div>{t("server.admin.settings.allowModelSelection")}</div>
                            <div className="text-xs text-stone-500">{t("server.admin.settings.allowModelSelectionHint")}</div>
                        </div>
                        <Switch checked={publicSettings.allowModelSelection} onChange={(checked) => setPublicSettings({ ...publicSettings, allowModelSelection: checked })} />
                    </div>
                    <label className="block max-w-xs">
                        <span className="mb-1 block text-sm font-medium">{t("server.admin.settings.retentionDays")}</span>
                        <InputNumber className="w-full" min={0} max={3650} precision={0} value={retentionDays} onChange={(value) => setRetentionDays(typeof value === "number" ? value : 90)} />
                        <span className="mt-0.5 block text-[11px] text-stone-400">{t("server.admin.settings.retentionDaysHint")}</span>
                    </label>
                </div>
            </Card>
            <Card size="small" title={t("server.admin.settings.passwordTitle")}>
                <div className="grid max-w-xl gap-3">
                    <Input.Password autoComplete="current-password" placeholder={t("server.admin.settings.oldPassword")} value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
                    <Input.Password autoComplete="new-password" placeholder={t("server.admin.settings.newPassword")} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                    <Input.Password autoComplete="new-password" placeholder={t("server.admin.settings.confirmPassword")} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                    <Button type="primary" loading={changingPassword} onClick={() => void changePassword()}>
                        {t("server.admin.settings.changePassword")}
                    </Button>
                </div>
            </Card>
            <Card size="small" title={t("server.admin.settings.serverTitle")}>
                <div className="grid gap-2 text-xs text-stone-500 md:grid-cols-2">
                    <div>
                        {t("server.admin.overview.version")}: {data?.server.version || "-"}
                    </div>
                    <div>
                        {t("server.admin.overview.uptime")}: {data ? formatUptime(data.server.uptimeSeconds) : "-"}
                    </div>
                </div>
            </Card>
            <Card size="small" title={t("server.admin.settings.dangerTitle")}>
                <Popconfirm title={t("server.admin.settings.resetAllConfirm")} onConfirm={() => void resetAll()}>
                    <Button danger size="small">
                        {t("server.admin.settings.resetAll")}
                    </Button>
                </Popconfirm>
                <div className="mt-1 text-[11px] text-stone-400">{t("server.admin.settings.resetAllHint")}</div>
            </Card>
        </div>
    );
}
