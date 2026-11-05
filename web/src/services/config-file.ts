import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function exportAppConfig() {
    const { config, webdav, serverMode } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    // 服务端模式下渠道与 Key 归管理员维护，导出只保留用户偏好，避免把占位 Key 写进配置文件。
    const exportConfig = serverMode ? { ...config, channels: [], baseUrl: "", apiKey: "", models: [] } : config;
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config: exportConfig, webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) throw new Error(i18n.t("config.invalidFile"));
    const current = useConfigStore.getState();
    if (current.serverMode) {
        // 服务端模式忽略导入文件中的渠道/Key，只采用用户偏好。
        useConfigStore.setState({
            config: {
                ...data.config,
                channels: current.config.channels,
                models: current.config.models,
                baseUrl: current.config.baseUrl,
                apiKey: current.config.apiKey,
                apiFormat: current.config.apiFormat,
                imageModel: current.config.imageModel,
                videoModel: current.config.videoModel,
                textModel: current.config.textModel,
                audioModel: current.config.audioModel,
            },
            webdav: data.webdav,
        });
    } else {
        useConfigStore.setState({ config: data.config, webdav: data.webdav });
    }
    usePromptSourceStore.setState(data.promptSources);
}
