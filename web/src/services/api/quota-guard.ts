import axios, { type AxiosError } from "axios";

import i18n from "@/i18n";
import { useConfigStore } from "@/stores/use-config-store";
import { quotaExhausted, useQuotaStore } from "@/stores/use-quota-store";
import type { ServerCapability } from "@/types/server";

/** 服务端模式下在发请求前做一次本地快速校验；真正的强制校验仍在服务端。 */
export function assertQuotaAvailable(capability: ServerCapability) {
    const configState = useConfigStore.getState();
    if (!configState.serverMode) return;
    const status = useQuotaStore.getState().status;
    if (!status) return;
    const usage = status.capabilities?.[capability];
    if (!usage) return;
    if (!quotaExhausted(status, capability)) return;
    const dailyExhausted = usage.dailyLimit > 0 && usage.dailyUsed >= usage.dailyLimit;
    const resetAt = dailyExhausted ? status.dailyResetAt : status.weeklyResetAt;
    const capabilityLabel = i18n.t(`server.capabilities.${capability}`);
    throw new Error(i18n.t("server.quota.exhausted", { capability: capabilityLabel, resetAt }));
}

type QuotaErrorBody = {
    code?: string;
    error?: { message?: string };
};

function isQuotaExceeded(error: AxiosError): boolean {
    const status = error.response?.status;
    const data = error.response?.data as QuotaErrorBody | undefined;
    return status === 429 && data?.code === "quota_exceeded";
}

let installed = false;

/** 统一在 axios 层同步额度状态：中转成功刷新一次，额度不足立即刷新。 */
export function installQuotaInterceptor() {
    if (installed) return;
    installed = true;
    axios.interceptors.response.use(
        (response) => {
            if (typeof response.config?.url === "string" && response.config.url.includes("/api/relay")) {
                useQuotaStore.getState().scheduleRefresh();
            }
            return response;
        },
        (error: AxiosError) => {
            if (isQuotaExceeded(error)) {
                useQuotaStore.getState().refresh();
            } else if (typeof error.config?.url === "string" && error.config.url.includes("/api/relay")) {
                useQuotaStore.getState().scheduleRefresh();
            }
            return Promise.reject(error);
        },
    );
}
