import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { nowMs } from "./clock";
import { getJsonSetting, setJsonSetting, transaction } from "./db";
import { decryptSecret, encryptSecret, maskSecret, normalizeBaseUrl, rewriteHostForDocker } from "./security";
import type { ApiFormat, Capability, ChannelModelRecord, ChannelRecord, PublicChannel, ToolProtocol } from "./types";
import { CAPABILITIES } from "./types";

type ChannelRow = {
    id: string;
    name: string;
    base_url: string;
    api_key_cipher: string;
    api_format: string;
    tool_protocol: string;
    enabled: number;
    sort: number;
    created_at: number;
    updated_at: number;
};

type ModelRow = {
    channel_id: string;
    name: string;
    capability: string;
    script: string | null;
    sort: number;
};

export type InternalChannel = ChannelRecord & { apiKey: string; sort: number };

export type ChannelInput = {
    id?: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    apiFormat?: string;
    toolProtocol?: string;
    enabled?: boolean;
    models?: Array<{ name?: string; capability?: string; script?: string }>;
};

const DEFAULT_MODELS_KEY = "default_models";

function mapCapability(value: string | undefined): Capability {
    return CAPABILITIES.includes(value as Capability) ? (value as Capability) : "text";
}

function mapApiFormat(value: string | undefined): ApiFormat {
    return value === "gemini" ? "gemini" : "openai";
}

function mapToolProtocol(value: string | undefined): ToolProtocol {
    return value === "native" || value === "text" ? value : "auto";
}

export function listChannels(db: Database, secret: string, options: { includeDisabled?: boolean } = {}): InternalChannel[] {
    const rows = (
        options.includeDisabled ? db.query("SELECT * FROM channels ORDER BY sort ASC, created_at ASC").all() : db.query("SELECT * FROM channels WHERE enabled = 1 ORDER BY sort ASC, created_at ASC").all()
    ) as ChannelRow[];
    const modelRows = db.query("SELECT * FROM channel_models ORDER BY sort ASC, name ASC").all() as ModelRow[];
    const modelsByChannel = new Map<string, ChannelModelRecord[]>();
    for (const row of modelRows) {
        const list = modelsByChannel.get(row.channel_id) ?? [];
        list.push({ name: row.name, capability: mapCapability(row.capability), ...(row.script ? { script: row.script } : {}) });
        modelsByChannel.set(row.channel_id, list);
    }
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        apiFormat: mapApiFormat(row.api_format),
        toolProtocol: mapToolProtocol(row.tool_protocol),
        enabled: row.enabled === 1,
        apiKey: decryptSecret(secret, row.api_key_cipher),
        sort: row.sort,
        models: modelsByChannel.get(row.id) ?? [],
    }));
}

export function publicChannels(channels: InternalChannel[]): PublicChannel[] {
    return channels
        .filter((channel) => channel.enabled)
        .map((channel) => ({
            id: channel.id,
            name: channel.name,
            baseUrl: channel.baseUrl,
            apiFormat: channel.apiFormat,
            toolProtocol: channel.toolProtocol,
            models: channel.models.map((model) => ({ name: model.name, capability: model.capability, ...(model.script ? { script: model.script } : {}) })),
        }));
}

/** 管理端展示：Key 掩码，不含密文。 */
export function maskedChannels(channels: InternalChannel[]) {
    return channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        baseUrl: channel.baseUrl,
        apiFormat: channel.apiFormat,
        toolProtocol: channel.toolProtocol,
        enabled: channel.enabled,
        apiKeyMasked: maskSecret(channel.apiKey),
        hasApiKey: Boolean(channel.apiKey),
        models: channel.models,
    }));
}

export function saveChannels(db: Database, secret: string, inputs: ChannelInput[], options: { runningInDocker?: boolean } = {}): void {
    if (!Array.isArray(inputs)) throw new Error("channels_must_be_array");
    const existing = new Map(listChannels(db, secret, { includeDisabled: true }).map((channel) => [channel.id, channel]));
    transaction(db, () => {
        db.query("DELETE FROM channels").run();
        inputs.forEach((input, index) => {
            const baseUrl = normalizeBaseUrl(rewriteHostForDocker(stringValue(input.baseUrl), Boolean(options.runningInDocker)));
            const apiFormat = mapApiFormat(input.apiFormat);
            const toolProtocol = mapToolProtocol(input.toolProtocol);
            const id = stringValue(input.id) || randomUUID();
            const keyInput = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
            const preservedKey = existing.get(id)?.apiKey ?? "";
            const plaintextKey = keyInput || preservedKey;
            const now = nowMs();
            db.query(
                "INSERT INTO channels (id, name, base_url, api_key_cipher, api_format, tool_protocol, enabled, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(id, stringValue(input.name) || `渠道 ${index + 1}`, baseUrl, encryptSecret(secret, plaintextKey), apiFormat, toolProtocol, input.enabled === false ? 0 : 1, index, now, now);
            const seen = new Set<string>();
            for (const model of input.models ?? []) {
                const name = stringValue(model.name).replace(/^models\//, "").trim();
                if (!name || seen.has(name)) continue;
                seen.add(name);
                db.query("INSERT INTO channel_models (channel_id, name, capability, script, sort) VALUES (?, ?, ?, ?, ?)").run(
                    id,
                    name,
                    mapCapability(model.capability),
                    typeof model.script === "string" && model.script.trim() ? model.script : null,
                    seen.size - 1,
                );
            }
        });
    });
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** 默认模型使用前端既有编码：`channelId::modelName`。 */
export function resolveDefaultModels(db: Database, channels: InternalChannel[]): Record<Capability, string> {
    const stored = getJsonSetting<Partial<Record<Capability, string>>>(db, DEFAULT_MODELS_KEY) ?? {};
    const available = new Map<string, Capability>();
    for (const channel of channels) {
        if (!channel.enabled) continue;
        for (const model of channel.models) available.set(`${channel.id}::${model.name}`, model.capability);
    }
    const result = {} as Record<Capability, string>;
    for (const capability of CAPABILITIES) {
        const storedValue = stored[capability];
        // 默认模型必须与能力匹配，避免把文本模型设成默认图片模型等历史脏数据继续生效。
        if (storedValue && available.get(storedValue) === capability) {
            result[capability] = storedValue;
            continue;
        }
        const fallback = channels.filter((channel) => channel.enabled).flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => `${channel.id}::${model.name}`))[0];
        result[capability] = fallback ?? "";
    }
    return result;
}

export function saveDefaultModels(db: Database, models: Partial<Record<Capability, string>>) {
    setJsonSetting(db, DEFAULT_MODELS_KEY, models);
}

/** 找出目标 URL 所属渠道（Base URL 前缀匹配，长前缀优先）。 */
export function findChannelForTarget(channels: InternalChannel[], target: URL): InternalChannel | null {
    const targetKey = `${target.origin}${target.pathname}`;
    const sorted = [...channels].sort((a, b) => b.baseUrl.length - a.baseUrl.length);
    for (const channel of sorted) {
        if (!channel.enabled) continue;
        if (targetKey === channel.baseUrl || targetKey.startsWith(`${channel.baseUrl}/`)) return channel;
    }
    return null;
}
