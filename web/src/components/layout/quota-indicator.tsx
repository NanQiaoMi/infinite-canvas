import type { CSSProperties } from "react";
import { Popover } from "antd";
import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { quotaUsageCapabilities, useQuotaStore } from "@/stores/use-quota-store";
import type { ServerCapability } from "@/types/server";

const CAPABILITY_KEYS: Record<ServerCapability, string> = {
    image: "server.capabilities.image",
    video: "server.capabilities.video",
    text: "server.capabilities.text",
    audio: "server.capabilities.audio",
};

function formatResetTime(value: string, locale: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 顶栏额度胶囊：只在服务端模式且存在限额能力时显示。 */
export function QuotaIndicator({ style, className }: { style?: CSSProperties; className?: string }) {
    const { t, i18n } = useTranslation();
    const serverMode = useConfigStore((state) => state.serverMode);
    const status = useQuotaStore((state) => state.status);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    if (!serverMode || !status) return null;
    const capabilities = quotaUsageCapabilities(status);
    if (!capabilities.length) return null;

    const primary = capabilities.includes("image") ? "image" : capabilities[0];
    const primaryUsage = status.capabilities[primary];
    const primaryLabel = t(CAPABILITY_KEYS[primary]);
    const dailyText = primaryUsage.dailyLimit > 0 ? `${primaryUsage.dailyUsed}/${primaryUsage.dailyLimit}` : null;
    const weeklyText = primaryUsage.weeklyLimit > 0 ? `${primaryUsage.weeklyUsed}/${primaryUsage.weeklyLimit}` : null;
    const buttonText = status.exempt ? t("server.quota.exempt") : [dailyText ? `${t("server.quota.today")}${primaryLabel} ${dailyText}` : "", weeklyText ? `${t("server.quota.week")} ${weeklyText}` : ""].filter(Boolean).join(" · ");

    const content = (
        <div className="w-64 text-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{t("server.quota.title")}</span>
                {status.exempt ? <span className="text-emerald-600 dark:text-emerald-400">{t("server.quota.exempt")}</span> : null}
            </div>
            <div className="space-y-2">
                {capabilities.map((capability) => {
                    const usage = status.capabilities[capability];
                    return (
                        <div key={capability} className="flex items-center justify-between gap-2">
                            <span className="text-stone-500">{t(CAPABILITY_KEYS[capability])}</span>
                            <span className="tabular-nums">
                                {usage.dailyLimit > 0 ? `${t("server.quota.today")} ${usage.dailyUsed}/${usage.dailyLimit}` : null}
                                {usage.dailyLimit > 0 && usage.weeklyLimit > 0 ? " · " : null}
                                {usage.weeklyLimit > 0 ? `${t("server.quota.week")} ${usage.weeklyUsed}/${usage.weeklyLimit}` : null}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div className="mt-2 border-t border-stone-200 pt-2 text-[11px] text-stone-500 dark:border-stone-700">
                <div>{t("server.quota.dailyReset", { time: formatResetTime(status.dailyResetAt, i18n.resolvedLanguage || "zh-CN") })}</div>
                {capabilities.some((capability) => status.capabilities[capability].weeklyLimit > 0) ? (
                    <div>{t("server.quota.weeklyReset", { time: formatResetTime(status.weeklyResetAt, i18n.resolvedLanguage || "zh-CN") })}</div>
                ) : null}
            </div>
            <button type="button" className="mt-2 w-full cursor-pointer text-left text-[11px] text-primary hover:underline" onClick={() => openConfigDialog(false, "preferences")}>
                {t("server.quota.details")}
            </button>
        </div>
    );

    return (
        <Popover content={content} trigger="click" placement="bottomRight" arrow={false}>
            <button type="button" className={className} style={style} aria-label={t("server.quota.title")} title={t("server.quota.title")}>
                <Gauge className="size-3.5" />
                <span className="tabular-nums">{buttonText}</span>
            </button>
        </Popover>
    );
}
