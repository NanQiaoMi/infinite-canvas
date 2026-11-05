import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { computeBrowserFingerprint } from "@/lib/fingerprint";
import { installQuotaInterceptor } from "@/services/api/quota-guard";
import { detectServer, registerFingerprint } from "@/services/api/server";
import { useConfigStore } from "@/stores/use-config-store";
import { useQuotaStore } from "@/stores/use-quota-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const handledServerProbe = useRef(false);
    const bootstrapChecked = useConfigStore((state) => state.bootstrapChecked);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const applyServerBootstrap = useConfigStore((state) => state.applyServerBootstrap);
    const markBootstrapChecked = useConfigStore((state) => state.markBootstrapChecked);
    const setQuotaStatus = useQuotaStore((state) => state.setStatus);
    const setQuotaBlocked = useQuotaStore((state) => state.setBlocked);

    usePromptSourceScheduler();

    // 统一额度同步：axios 中转请求成功/失败后刷新额度；页面可见时每 60s 校准一次。
    useEffect(() => {
        installQuotaInterceptor();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") void useQuotaStore.getState().refresh();
        }, 60_000);
        return () => window.clearInterval(timer);
    }, []);

    // 启动探测：命中 /api/bootstrap 即进入服务端模式（渠道与额度由管理员统一配置）。
    useEffect(() => {
        if (handledServerProbe.current) return;
        handledServerProbe.current = true;
        let cancelled = false;
        void (async () => {
            const bootstrap = await detectServer();
            if (cancelled) return;
            if (!bootstrap) {
                markBootstrapChecked();
                return;
            }
            applyServerBootstrap(bootstrap);
            markBootstrapChecked();
            if (bootstrap.quota) setQuotaStatus(bootstrap.quota);
            try {
                const fingerprint = computeBrowserFingerprint();
                const session = await registerFingerprint({
                    visitorId: fingerprint.visitorId,
                    source: fingerprint.source,
                    ua: navigator.userAgent,
                    lang: navigator.language,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
                if (cancelled) return;
                setQuotaStatus(session.quota);
                setQuotaBlocked(session.blocked);
                if (session.blocked) message.error(t("server.blocked"));
            } catch {
                // 会话登记失败不阻塞页面；生成请求仍由服务端强制校验。
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [applyServerBootstrap, markBootstrapChecked, message, setQuotaBlocked, setQuotaStatus, t]);

    // URL 参数导入渠道仅在静态模式生效；服务端模式下渠道由管理员统一配置。
    useEffect(() => {
        if (!bootstrapChecked || handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        if (useConfigStore.getState().serverMode) {
            message.info(t("server.managedConfig"));
            return;
        }
        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [bootstrapChecked, importChannelCredentials, message, openConfigDialog, t]);

    return <>{children}</>;
}
