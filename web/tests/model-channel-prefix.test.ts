import { describe, expect, test } from "bun:test";

import { findModelOptionByQuery, formatChannelModelList, type AiConfig } from "@/stores/use-config-store";

const mockConfig: AiConfig = {
    channelMode: "local",
    baseUrl: "https://api.openai.com",
    apiKey: "test",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: "官方渠道",
            baseUrl: "https://api.openai.com",
            apiKey: "key-1",
            apiFormat: "openai",
            models: [
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o", capability: "text" },
                { name: "dall-e-3", capability: "image" },
            ],
        },
        {
            id: "azure-openai",
            name: "Azure专区",
            baseUrl: "https://azure.openai.com",
            apiKey: "key-2",
            apiFormat: "openai",
            models: [
                { name: "gpt-4o", capability: "text" },
                { name: "claude-3-5-sonnet", capability: "text" },
            ],
        },
    ],
    model: "default::gpt-5.5",
    imageModel: "default::dall-e-3",
    videoModel: "",
    textModel: "default::gpt-5.5",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "false",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-5.5", "default::gpt-4o", "azure-openai::gpt-4o", "azure-openai::claude-3-5-sonnet"],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "1",
    proxyEnabled: false,
    proxyUrl: "",
    nodeRegenerateBehavior: "new-node",
    autoFocusOnSelect: false,
};

describe("/model 渠道前缀与模型匹配", () => {
    test("支持 channelId/model 格式指定渠道模型", () => {
        const res1 = findModelOptionByQuery("azure-openai/gpt-4o", mockConfig, "text");
        expect(res1.matched).toBe("azure-openai::gpt-4o");
        expect(res1.channel?.id).toBe("azure-openai");

        const res2 = findModelOptionByQuery("default/gpt-4o", mockConfig, "text");
        expect(res2.matched).toBe("default::gpt-4o");
        expect(res2.channel?.id).toBe("default");
    });

    test("支持 channelName/model 中文与别名渠道前缀", () => {
        const res1 = findModelOptionByQuery("Azure专区/gpt-4o", mockConfig, "text");
        expect(res1.matched).toBe("azure-openai::gpt-4o");

        const res2 = findModelOptionByQuery("官方渠道/gpt-5.5", mockConfig, "text");
        expect(res2.matched).toBe("default::gpt-5.5");
    });

    test("支持冒号分隔符（channel:model 与 channel::model）", () => {
        const resColon = findModelOptionByQuery("azure-openai:claude-3-5-sonnet", mockConfig, "text");
        expect(resColon.matched).toBe("azure-openai::claude-3-5-sonnet");

        const resDoubleColon = findModelOptionByQuery("default::gpt-5.5", mockConfig, "text");
        expect(resDoubleColon.matched).toBe("default::gpt-5.5");
    });

    test("前缀与模型名均大小写不敏感", () => {
        const res = findModelOptionByQuery("AZURE-OPENAI/GPT-4O", mockConfig, "text");
        expect(res.matched).toBe("azure-openai::gpt-4o");
    });

    test("无前缀纯模型名：唯一时直接匹配", () => {
        const res = findModelOptionByQuery("claude-3-5-sonnet", mockConfig, "text");
        expect(res.matched).toBe("azure-openai::claude-3-5-sonnet");
    });

    test("无前缀同名模型：优先匹配当前已选渠道", () => {
        // 当前 textModel 是 default::gpt-5.5，属于 default 渠道
        const res = findModelOptionByQuery("gpt-4o", mockConfig, "text");
        expect(res.matched).toBe("default::gpt-4o");
    });

    test("输入渠道名时返回该渠道下的模型建议", () => {
        const res = findModelOptionByQuery("Azure专区", mockConfig, "text");
        expect(res.matched).toBeNull();
        expect(res.suggestions).toEqual(["Azure专区/gpt-4o", "Azure专区/claude-3-5-sonnet"]);
    });

    test("不存在的模型返回 matched: null", () => {
        const res = findModelOptionByQuery("non-existent-model", mockConfig, "text");
        expect(res.matched).toBeNull();
    });

    test("格式化模型列表展示渠道信息", () => {
        const list = formatChannelModelList(mockConfig, "text");
        expect(list).toContain("官方渠道/gpt-5.5（default/gpt-5.5）");
        expect(list).toContain("Azure专区/claude-3-5-sonnet（azure-openai/claude-3-5-sonnet）");
    });
});
