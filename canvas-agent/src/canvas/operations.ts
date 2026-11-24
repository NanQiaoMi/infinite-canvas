import crypto from "node:crypto";

import type { ToolName } from "./schemas.js";
import { nextCanvasX } from "./tools.js";
import type { CanvasNode, CanvasNodeType, CanvasSnapshot } from "./types.js";

export type CanvasToolRequest = { name: "canvas_apply_ops"; input: Record<string, unknown> };

/** 将上层画布工具调用转换为前端可执行的批量操作。 */
export function buildCanvasToolRequest(name: ToolName, input: Record<string, unknown>, state: CanvasSnapshot | null): CanvasToolRequest {
    if (name === "canvas_apply_ops") return { name, input };
    if (name === "canvas_create_node") {
        const data = input as { nodeType: CanvasNodeType; title?: string; x?: number; y?: number; width?: number; height?: number; metadata?: Record<string, unknown> };
        return applyOps([{ type: "add_node", nodeType: data.nodeType, title: data.title, position: { x: data.x ?? nextCanvasX(state), y: data.y ?? 0 }, width: data.width, height: data.height, metadata: data.metadata }]);
    }
    if (name === "canvas_create_text_node") {
        const data = input as { text?: string; x?: number; y?: number; title?: string; width?: number; height?: number };
        return applyOps([textNodeOp(data, data.x ?? nextCanvasX(state), data.y ?? 0)]);
    }
    if (name === "canvas_create_text_nodes") {
        const data = input as { items: Array<{ text: string; title?: string; x?: number; y?: number; width?: number; height?: number }>; x?: number; y?: number; gap?: number; direction?: "row" | "column" };
        const x = Number(data.x ?? nextCanvasX(state));
        const y = Number(data.y ?? 0);
        const gap = Number(data.gap ?? 40);
        return applyOps(data.items.map((item, index) => textNodeOp(item, item.x ?? (data.direction === "row" ? x + index * (340 + gap) : x), item.y ?? (data.direction === "row" ? y : y + index * (240 + gap)))));
    }
    if (name === "canvas_create_image_prompt_flow") return applyOps(generationFlowOps({ ...input, mode: "image" }, state));
    if (name === "canvas_create_config_node") {
        const x = Number(input.x ?? nextCanvasX(state));
        const y = Number(input.y ?? 0);
        const configId = `config-${crypto.randomUUID()}`;
        const mode = generationMode(input.mode);
        const prompt = String(input.prompt || "");
        return applyOps([configNodeOp(configId, input, x, y), ...(input.autoRun ? [runGenerationOp(configId, mode, prompt)] : [])]);
    }
    if (name === "canvas_create_generation_flow") return applyOps(generationFlowOps(input, state));
    if (name === "canvas_create_storyboard_flow") return applyOps(storyboardFlowOps(input, state));
    if (name === "canvas_generate_text" || name === "canvas_generate_image" || name === "canvas_generate_video" || name === "canvas_generate_audio") {
        return applyOps(generationFlowOps({ ...input, mode: name.replace("canvas_generate_", ""), autoRun: true }, state));
    }
    if (name === "canvas_update_node") {
        const data = input as { id: string; patch?: Record<string, unknown>; metadata?: Record<string, unknown> };
        return applyOps([{ type: "update_node", id: data.id, patch: data.patch, metadata: data.metadata }]);
    }
    if (name === "canvas_update_node_text") {
        const data = input as { id: string; text: string; title?: string };
        return applyOps([{ type: "update_node", id: data.id, patch: { ...(data.title ? { title: data.title } : {}) }, metadata: { content: data.text, status: "success" } }]);
    }
    if (name === "canvas_move_nodes") {
        const data = input as { items: Array<{ id: string; x?: number; y?: number; dx?: number; dy?: number }> };
        return applyOps(data.items.map((item) => {
            const current = findNode(state, item.id);
            return { type: "update_node", id: item.id, patch: { position: { x: item.x ?? ((current?.position.x || 0) + (item.dx || 0)), y: item.y ?? ((current?.position.y || 0) + (item.dy || 0)) } } };
        }));
    }
    if (name === "canvas_auto_layout") return applyOps(autoLayoutOps(input, state));
    if (name === "canvas_resize_node") {
        const data = input as { id: string; width: number; height: number; freeResize?: boolean };
        return applyOps([{ type: "update_node", id: data.id, patch: { width: data.width, height: data.height }, metadata: data.freeResize === undefined ? undefined : { freeResize: data.freeResize } }]);
    }
    if (name === "canvas_delete_nodes") return applyOps([{ type: "delete_node", ids: (input as { ids: string[] }).ids }]);
    if (name === "canvas_connect_nodes") {
        const data = input as { connections: Array<{ fromNodeId: string; toNodeId: string }> };
        return applyOps(data.connections.map((connection) => ({ type: "connect_nodes", ...connection })));
    }
    if (name === "canvas_select_nodes") return applyOps([{ type: "select_nodes", ids: (input as { ids: string[] }).ids }]);
    if (name === "canvas_set_viewport") return applyOps([{ type: "set_viewport", viewport: (input as { viewport: unknown }).viewport }]);
    if (name === "canvas_run_generation") {
        const data = input as { nodeId: string; mode?: string; prompt?: string };
        return applyOps([runGenerationOp(data.nodeId, generationMode(data.mode), data.prompt)]);
    }
    throw new Error(`未知工具：${name}`);
}

/** 按最大边限制计算附件图片节点尺寸，并保持原始比例。 */
export function fitAttachmentNodeSize(width: number, height: number) {
    const scale = Math.min(1, 640 / width, 640 / height);
    return { width: width * scale, height: height * scale };
}

/** 创建统一的批量画布操作请求。 */
function applyOps(ops: unknown[]): CanvasToolRequest {
    return { name: "canvas_apply_ops", input: { ops } };
}

/** 创建文本节点操作。 */
function textNodeOp(input: { id?: string; text?: string; title?: string; width?: number; height?: number }, x: number, y: number) {
    return { type: "add_node", id: input.id, nodeType: "text", title: input.title, position: { x, y }, width: input.width, height: input.height, metadata: { content: input.text || "", status: "success", fontSize: 14 } };
}

/** 创建生成配置节点操作。 */
function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    return {
        type: "add_node",
        id,
        nodeType: "config",
        title: String(input.title || generationTitle(mode)),
        position: { x, y },
        width: typeof input.width === "number" ? input.width : undefined,
        height: typeof input.height === "number" ? input.height : undefined,
        metadata: cleanRecord({
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: input.model,
            size: input.size,
            quality: input.quality,
            count: input.count,
            seconds: input.seconds,
            vquality: input.vquality,
            generateAudio: input.generateAudio,
            watermark: input.watermark,
            videoMode: input.videoMode,
            audioVoice: input.audioVoice,
            audioFormat: input.audioFormat,
            audioSpeed: input.audioSpeed,
            audioInstructions: input.audioInstructions,
        }),
    };
}

/** 创建包含提示词、配置节点和引用连线的生成流程。 */
function generationFlowOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    const x = Number(input.x ?? nextCanvasX(state));
    const y = Number(input.y ?? 0);
    const textId = `text-${crypto.randomUUID()}`;
    const configId = `config-${crypto.randomUUID()}`;
    const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : [];
    if (mode === "video" && referenceNodeIds.length > 10) {
        throw new Error(`视频生成最多支持 10 个参考节点（当前 ${referenceNodeIds.length} 个）`);
    }
    const flowInput = mode === "video" && referenceNodeIds.length > 2 && !input.videoMode ? { ...input, videoMode: "reference" } : input;
    // When the prompt only @-mentions nodes already passed as references, reuse them instead of minting a duplicate text node.
    const mentionedIds = [...prompt.matchAll(/@\[node:([\w-]+)\]/g)].map((match) => match[1]);
    const reuseReferences = referenceNodeIds.length > 0 && mentionedIds.length > 0
        && mentionedIds.every((id) => referenceNodeIds.includes(id))
        && prompt.replace(/@\[node:[\w-]+\]/g, "").trim() === "";
    const tokens = reuseReferences ? referenceNodeIds.map((id) => `@[node:${id}]`) : [`@[node:${textId}]`, ...referenceNodeIds.map((id) => `@[node:${id}]`)];
    return [
        ...(reuseReferences ? [] : [textNodeOp({ id: textId, text: prompt, title: String(input.title || "提示词") }, x, y)]),
        configNodeOp(configId, { ...flowInput, prompt: tokens.join("\n") }, x + 420, y),
        ...(reuseReferences ? [] : [{ type: "connect_nodes", fromNodeId: textId, toNodeId: configId }]),
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes", fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGenerationOp(configId, mode, tokens.join("\n"))] : []),
    ];
}

/** 批量创建多镜头分镜生成工作流：按行排布文本/配置节点，统一去重连线共享定妆照与单镜参考节点。 */
function storyboardFlowOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const shots = Array.isArray(input.shots) ? (input.shots as Array<Record<string, unknown>>) : [];
    if (!shots.length) throw new Error("请至少提供 1 个分镜项 shots");
    const sharedRefs = Array.isArray(input.sharedReferenceNodeIds)
        ? input.sharedReferenceNodeIds.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
    const mode = input.mode ? generationMode(input.mode) : "video";
    const startX = Number(input.x ?? nextCanvasX(state));
    const startY = Number(input.y ?? 0);
    const rowGap = Number(input.rowGap ?? 320);

    const ops: Array<Record<string, unknown>> = [];
    const configIds: string[] = [];
    let firstPromptTokens = "";

    shots.forEach((shot, index) => {
        const shotRefs = Array.isArray(shot.referenceNodeIds)
            ? shot.referenceNodeIds.filter((id): id is string => typeof id === "string" && Boolean(id))
            : [];
        const mergedRefs = Array.from(new Set([...shotRefs, ...sharedRefs]));
        if (mode === "video" && mergedRefs.length > 10) {
            throw new Error(`第 ${index + 1} 镜参考节点超过 10 个（当前 ${mergedRefs.length} 个）`);
        }
        const rowY = startY + index * rowGap;
        const textId = `text-${crypto.randomUUID()}`;
        const configId = `config-${crypto.randomUUID()}`;
        configIds.push(configId);
        const tokens = [`@[node:${textId}]`, ...mergedRefs.map((id) => `@[node:${id}]`)].join("\n");
        if (index === 0) firstPromptTokens = tokens;

        const videoMode = shot.videoMode ?? input.videoMode ?? (mode === "video" && mergedRefs.length > 2 ? "reference" : undefined);
        const mergedConfigInput = {
            ...input,
            ...cleanRecord({
                title: shot.title ? `${String(shot.title)} 生成` : `第 ${index + 1} 镜`,
                seconds: shot.seconds,
                size: shot.size,
                vquality: shot.vquality,
                videoMode,
            }),
            mode,
            prompt: tokens,
        };
        ops.push(
            textNodeOp({ id: textId, text: String(shot.prompt || ""), title: String(shot.title || `镜 ${index + 1} 提示词`) }, startX, rowY),
            configNodeOp(configId, mergedConfigInput, startX + 420, rowY),
            { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
            ...mergedRefs.map((fromNodeId) => ({ type: "connect_nodes", fromNodeId, toNodeId: configId })),
        );
    });

    ops.push({ type: "select_nodes", ids: configIds });
    if (input.autoRunFirst === true && configIds.length > 0) {
        ops.push(runGenerationOp(configIds[0], mode, firstPromptTokens));
    }
    return ops;
}

/** 按连线拓扑从左到右分层排布节点，互不相连的流程按行分组并可选居中视口。 */
function autoLayoutOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const allNodes = state?.nodes || [];
    const filterIds = Array.isArray(input.nodeIds)
        ? new Set(input.nodeIds.filter((id): id is string => typeof id === "string" && Boolean(id)))
        : null;
    const targetNodes = filterIds && filterIds.size ? allNodes.filter((node) => filterIds.has(node.id)) : [...allNodes];
    if (!targetNodes.length) return [];

    const colGap = Number(input.colGap ?? 100);
    const rowGap = Number(input.rowGap ?? 64);
    const groupGap = Number(input.groupGap ?? 120);
    const fitViewport = input.fitViewport !== false;
    const targetById = new Map(targetNodes.map((node) => [node.id, node]));

    const undirected = new Map<string, Set<string>>();
    const outgoing = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const node of targetNodes) {
        undirected.set(node.id, new Set());
        outgoing.set(node.id, []);
        indegree.set(node.id, 0);
    }

    const seenDirected = new Set<string>();
    for (const conn of state?.connections || []) {
        if (!targetById.has(conn.fromNodeId) || !targetById.has(conn.toNodeId) || conn.fromNodeId === conn.toNodeId) continue;
        undirected.get(conn.fromNodeId)!.add(conn.toNodeId);
        undirected.get(conn.toNodeId)!.add(conn.fromNodeId);
        const edgeKey = `${conn.fromNodeId}->${conn.toNodeId}`;
        if (seenDirected.has(edgeKey)) continue;
        seenDirected.add(edgeKey);
        outgoing.get(conn.fromNodeId)!.push(conn.toNodeId);
        indegree.set(conn.toNodeId, (indegree.get(conn.toNodeId) || 0) + 1);
    }

    const byPos = (a: CanvasNode, b: CanvasNode) => (a.position.y - b.position.y) || (a.position.x - b.position.x) || a.id.localeCompare(b.id);
    const visited = new Set<string>();
    const components: CanvasNode[][] = [];
    for (const seed of [...targetNodes].sort(byPos)) {
        if (visited.has(seed.id)) continue;
        const comp: CanvasNode[] = [];
        const queue = [seed.id];
        visited.add(seed.id);
        while (queue.length) {
            const id = queue.shift()!;
            comp.push(targetById.get(id)!);
            for (const nextId of undirected.get(id)!) {
                if (!visited.has(nextId)) {
                    visited.add(nextId);
                    queue.push(nextId);
                }
            }
        }
        components.push(comp);
    }
    components.sort(
        (a, b) =>
            Math.min(...a.map((n) => n.position.y)) - Math.min(...b.map((n) => n.position.y)) ||
            Math.min(...a.map((n) => n.position.x)) - Math.min(...b.map((n) => n.position.x)),
    );

    const originX = Math.min(...targetNodes.map((n) => n.position.x));
    let groupTopY = Math.min(...targetNodes.map((n) => n.position.y));
    const ops: Array<Record<string, unknown>> = [];

    for (const comp of components) {
        const layer = new Map<string, number>();
        const remaining = new Map(comp.map((n) => [n.id, indegree.get(n.id) || 0]));
        const kahn = comp.filter((n) => (remaining.get(n.id) || 0) === 0).sort(byPos).map((n) => n.id);
        for (const id of kahn) layer.set(id, 0);

        for (let i = 0; i < kahn.length; i += 1) {
            const u = kahn[i];
            const nextLayer = (layer.get(u) || 0) + 1;
            for (const v of outgoing.get(u)!) {
                layer.set(v, Math.max(layer.get(v) || 0, nextLayer));
                const nextDeg = (remaining.get(v) || 0) - 1;
                remaining.set(v, nextDeg);
                if (nextDeg === 0) kahn.push(v);
            }
        }

        // 若存在环路导致部分节点入度未归零，则顺延分配至后续列以防止死循环与重叠。
        let fallbackLayer = layer.size ? Math.max(...layer.values()) + 1 : 0;
        for (const node of [...comp].sort(byPos)) {
            if (!layer.has(node.id)) {
                layer.set(node.id, fallbackLayer);
                fallbackLayer += 1;
            }
        }

        const columns = new Map<number, CanvasNode[]>();
        for (const node of comp) {
            const col = layer.get(node.id) || 0;
            const bucket = columns.get(col) || [];
            bucket.push(node);
            columns.set(col, bucket);
        }

        const colIndexes = [...columns.keys()].sort((a, b) => a - b);
        let colX = originX;
        let groupMaxBottom = groupTopY;

        for (const colIdx of colIndexes) {
            const colNodes = columns.get(colIdx)!.sort(byPos);
            const colWidth = Math.max(...colNodes.map((n) => n.width || 320));
            let rowY = groupTopY;
            for (const node of colNodes) {
                ops.push({ type: "update_node", id: node.id, patch: { position: { x: Math.round(colX), y: Math.round(rowY) } } });
                rowY += (node.height || 200) + rowGap;
            }
            groupMaxBottom = Math.max(groupMaxBottom, rowY - rowGap);
            colX += colWidth + colGap;
        }

        groupTopY = groupMaxBottom + groupGap;
    }

    // 视口适配交给网页按真实画布尺寸计算。
    if (fitViewport) ops.push({ type: "fit_view", ids: targetNodes.map((node) => node.id) });

    return ops;
}

/** 创建触发节点生成的画布操作。 */
function runGenerationOp(nodeId: string, mode: "text" | "image" | "video" | "audio", prompt?: string) {
    return { type: "run_generation", nodeId, mode, prompt };
}

/** 将未知生成模式归一为画布支持的模式。 */
function generationMode(value: unknown): "text" | "image" | "video" | "audio" {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

/** 获取生成模式对应的默认节点标题。 */
function generationTitle(mode: "text" | "image" | "video" | "audio") {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

/** 按节点 ID 查找当前画布节点。 */
function findNode(state: CanvasSnapshot | null, id: string): CanvasNode | undefined {
    return (state?.nodes || []).find((node) => node.id === id);
}

/** 移除对象中未设置的生成参数。 */
function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}
