import { nanoid } from "nanoid";

import { useAgentStore } from "@/stores/use-agent-store";
import { inferImageSizeFromPrompt } from "./aspect-ratio";
import { computeBatchLayoutPositions, computeNextNodePosition, computeNodesBoundingViewport, type LayoutMode } from "@/lib/canvas/canvas-layout-planner";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { AgentToolCall, AgentToolDefinition, AgentToolErrorCode, AgentToolResult } from "./types";
import { validateArguments } from "./protocol";

export const CANVAS_AGENT_TOOLS: AgentToolDefinition[] = [
    {
        name: "canvas_get_context",
        description: "获取当前无限画布的实时状态上下文，包括所有节点列表（ID、类型、提示词、图片状态、坐标与尺寸）、选中的节点、连线关系和视口。",
        parameters: {
            type: "object",
            properties: {
                includeDetails: { type: "boolean", description: "是否包含各节点的详细元数据，默认 true" },
            },
        },
    },
    {
        name: "canvas_create_image_node",
        description: "在画布上创建单个图片生成节点并立即启动生成。自动推断合理尺寸比例；未指定坐标时自动计算空位排布，避免重叠覆盖。",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "用于生成画面的提示词" },
                title: { type: "string", description: "节点标题，如「海报主体」、「赛博机甲」" },
                size: {
                    type: "string",
                    description: "画幅比例与尺寸，如 1024x1024 (1:1), 1536x864 (16:9), 864x1536 (9:16), 768x1024 (3:4)；省略时根据题材自动推断",
                },
                background: {
                    type: "string",
                    enum: ["transparent", "auto"],
                    description: "背景模式。透明底素材或PNG免抠图传 \"transparent\"",
                },
                x: { type: "number", description: "画布横坐标（省略时自动计算空闲位置）" },
                y: { type: "number", description: "画布纵坐标（省略时自动计算空闲位置）" },
                run: { type: "boolean", description: "是否立即在画布上触发生成渲染，默认 true" },
            },
            required: ["prompt"],
        },
    },
    {
        name: "canvas_batch_generate_nodes",
        description: "批量在画布上排布生成多个图片节点并同时启动生成。适用于拆解复杂海报、多角度角色设计、分镜创作、成套素材/图标等任务。",
        parameters: {
            type: "object",
            properties: {
                tasks: {
                    type: "array",
                    description: "要生成的子任务列表（1-12项）",
                    items: {
                        type: "object",
                        properties: {
                            prompt: { type: "string", description: "子任务提示词" },
                            title: { type: "string", description: "节点标题，如「图层1: 背景」" },
                            size: { type: "string", description: "画幅尺寸，如 1024x1024" },
                            background: { type: "string", enum: ["transparent", "auto"], description: "背景模式" },
                        },
                        required: ["prompt"],
                    },
                },
                layout: {
                    type: "string",
                    enum: ["grid", "horizontal", "vertical"],
                    description: "自动排列规则：grid (网格，默认), horizontal (横向并排), vertical (纵向并排)",
                },
                run: { type: "boolean", description: "是否立即启动全部节点的生成，默认 true" },
            },
            required: ["tasks"],
        },
    },
    {
        name: "canvas_create_text_node",
        description: "在画布上创建文本便签或提示词节点，记录设计理念、方案拆解或文案标题。",
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "文本便签内容" },
                title: { type: "string", description: "节点标题，默认「文本灵感」" },
                x: { type: "number", description: "横坐标" },
                y: { type: "number", description: "纵坐标" },
            },
            required: ["text"],
        },
    },
    {
        name: "canvas_update_node",
        description: "修改画布上已有节点的提示词或标题，并可选择是否重新生成。",
        parameters: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "要修改的节点 ID" },
                prompt: { type: "string", description: "新的提示词" },
                title: { type: "string", description: "新的节点标题" },
                rerun: { type: "boolean", description: "是否立即重新生成，默认 false" },
            },
            required: ["nodeId"],
        },
    },
    {
        name: "canvas_connect_nodes",
        description: "在两个画布节点之间建立连线关系（如提示词节点连到生图节点）。",
        parameters: {
            type: "object",
            properties: {
                fromNodeId: { type: "string", description: "连线起点节点 ID" },
                toNodeId: { type: "string", description: "连线终点节点 ID" },
            },
            required: ["fromNodeId", "toNodeId"],
        },
    },
    {
        name: "canvas_delete_nodes",
        description: "删除画布上的指定节点；未传 nodeIds 时默认删除当前选中的节点。",
        parameters: {
            type: "object",
            properties: {
                nodeIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "要删除的节点 ID 列表；不传则删除当前选区",
                },
            },
        },
    },
    {
        name: "canvas_focus_nodes",
        description: "调整视口居中并聚焦到指定节点或全部节点。",
        parameters: {
            type: "object",
            properties: {
                nodeIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "要聚焦的节点 ID 列表；若为空则聚焦画布全部节点",
                },
            },
        },
    },
];

export function isCanvasTool(toolName: string): boolean {
    return toolName.startsWith("canvas_");
}

function failure(tool: string, code: AgentToolErrorCode, error: string): AgentToolResult {
    return { tool, ok: false, code, error };
}

export async function executeCanvasAgentTool(call: AgentToolCall): Promise<AgentToolResult> {
    const canvasContext = useAgentStore.getState().canvasContext;
    if (!canvasContext) {
        return failure(call.tool, "execution_failed", "当前未处于无限画布工程中。请进入顶部导航「我的画布」打开任意画布，并在右侧画布助手中执行本指令。");
    }

    const definition = CANVAS_AGENT_TOOLS.find((t) => t.name === call.tool);
    if (!definition) {
        return failure(call.tool, "unsupported", `不支持的画布工具: ${call.tool}`);
    }

    const validation = validateArguments(definition.parameters, call.arguments);
    if (!validation.ok) {
        return failure(call.tool, "invalid_args", validation.error);
    }

    const snapshot = canvasContext.snapshot;
    const args = validation.value;

    try {
        if (call.tool === "canvas_get_context") {
            const nodes = (snapshot.nodes || []).map((node) => ({
                id: node.id,
                type: node.type,
                title: node.title,
                prompt: (node.metadata?.composerContent || node.metadata?.prompt || "") as string,
                x: node.position?.x ?? 0,
                y: node.position?.y ?? 0,
                width: node.width,
                height: node.height,
                hasImage: Boolean(node.metadata?.content || node.metadata?.storageKey),
            }));
            const connections = (snapshot.connections || []).map((c) => ({
                id: c.id,
                fromNodeId: c.fromNodeId,
                toNodeId: c.toNodeId,
            }));
            return {
                tool: "canvas_get_context",
                ok: true,
                projectId: snapshot.projectId,
                title: snapshot.title,
                nodeCount: nodes.length,
                selectedNodeIds: snapshot.selectedNodeIds || [],
                nodes,
                connections,
            };
        }

        if (call.tool === "canvas_create_image_node") {
            const prompt = String(args.prompt || "").trim();
            if (!prompt) return failure("canvas_create_image_node", "invalid_args", "提示词不能为空");

            const background = args.background === "transparent" ? "transparent" : undefined;
            const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : inferImageSizeFromPrompt(prompt, "1024x1024");
            const ratioSize = nodeSizeFromRatio(size, 340, 240) || { width: 340, height: 240 };
            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "AI 生图节点";

            const position =
                typeof args.x === "number" && typeof args.y === "number"
                    ? { x: args.x, y: args.y }
                    : computeNextNodePosition(snapshot.nodes, snapshot.viewport, ratioSize);

            const nodeId = `image-${Date.now()}-${nanoid(4)}`;
            const metadata = {
                prompt,
                composerContent: prompt,
                size,
                generationType: "text-to-image" as const,
                generationMode: "image" as const,
                ...(background ? { background } : {}),
            };

            const ops: CanvasAgentOp[] = [
                {
                    type: "add_node",
                    id: nodeId,
                    nodeType: "image",
                    title,
                    position,
                    width: ratioSize.width,
                    height: ratioSize.height,
                    metadata,
                },
            ];

            const run = args.run !== false;
            if (run) {
                ops.push({ type: "run_generation", nodeId, mode: "image", prompt });
            }

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_create_image_node",
                ok: true,
                nodeId,
                title,
                prompt,
                size,
                position,
            };
        }

        if (call.tool === "canvas_batch_generate_nodes") {
            const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
            if (!rawTasks.length) return failure("canvas_batch_generate_nodes", "invalid_args", "批量生成任务列表不能为空");

            const tasks = rawTasks.slice(0, 12);
            const layout = (args.layout as LayoutMode) || "grid";
            const run = args.run !== false;

            const baseSize = { width: 340, height: 240 };
            const positions = computeBatchLayoutPositions(tasks.length, layout, snapshot.nodes, snapshot.viewport, baseSize);

            const ops: CanvasAgentOp[] = [];
            const createdNodes: Array<{ nodeId: string; title: string; prompt: string; size: string; position: { x: number; y: number } }> = [];

            tasks.forEach((task, index) => {
                const prompt = String(task.prompt || "").trim();
                const background = task.background === "transparent" ? "transparent" : undefined;
                const size = typeof task.size === "string" && task.size.trim() ? task.size.trim() : inferImageSizeFromPrompt(prompt, "1024x1024");
                const ratioSize = nodeSizeFromRatio(size, 340, 240) || baseSize;
                const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : `素材 ${index + 1}`;
                const position = positions[index] || { x: 100 + index * 360, y: 100 };
                const nodeId = `image-${Date.now()}-${nanoid(4)}-${index}`;

                const metadata = {
                    prompt,
                    composerContent: prompt,
                    size,
                    generationType: "text-to-image" as const,
                    generationMode: "image" as const,
                    ...(background ? { background } : {}),
                };

                ops.push({
                    type: "add_node",
                    id: nodeId,
                    nodeType: "image",
                    title,
                    position,
                    width: ratioSize.width,
                    height: ratioSize.height,
                    metadata,
                });

                if (run) {
                    ops.push({ type: "run_generation", nodeId, mode: "image", prompt });
                }

                createdNodes.push({ nodeId, title, prompt, size, position });
            });

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_batch_generate_nodes",
                ok: true,
                count: createdNodes.length,
                layout,
                nodes: createdNodes,
            };
        }

        if (call.tool === "canvas_create_text_node") {
            const text = String(args.text || "").trim();
            if (!text) return failure("canvas_create_text_node", "invalid_args", "文本内容不能为空");

            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "文本便签";
            const size = { width: 340, height: 240 };
            const position =
                typeof args.x === "number" && typeof args.y === "number"
                    ? { x: args.x, y: args.y }
                    : computeNextNodePosition(snapshot.nodes, snapshot.viewport, size);

            const nodeId = `text-${Date.now()}-${nanoid(4)}`;
            const ops: CanvasAgentOp[] = [
                {
                    type: "add_node",
                    id: nodeId,
                    nodeType: "text",
                    title,
                    position,
                    width: size.width,
                    height: size.height,
                    metadata: { content: text },
                },
            ];

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_create_text_node",
                ok: true,
                nodeId,
                title,
                text,
                position,
            };
        }

        if (call.tool === "canvas_update_node") {
            const nodeId = String(args.nodeId || "").trim();
            const target = snapshot.nodes.find((n) => n.id === nodeId);
            if (!target) return failure("canvas_update_node", "invalid_args", `未在画布上找到节点: ${nodeId}`);

            const updatedFields: string[] = [];
            const patch: Record<string, unknown> = {};
            const metadataPatch: Record<string, unknown> = {};

            if (typeof args.title === "string" && args.title.trim()) {
                patch.title = args.title.trim();
                updatedFields.push("title");
            }
            if (typeof args.prompt === "string" && args.prompt.trim()) {
                const prompt = args.prompt.trim();
                metadataPatch.prompt = prompt;
                metadataPatch.composerContent = prompt;
                updatedFields.push("prompt");
            }

            const ops: CanvasAgentOp[] = [
                {
                    type: "update_node",
                    id: nodeId,
                    patch: { ...patch, metadata: { ...target.metadata, ...metadataPatch } },
                },
            ];

            const rerun = args.rerun === true;
            if (rerun) {
                ops.push({ type: "run_generation", nodeId, mode: "image", prompt: (metadataPatch.prompt as string) || target.metadata?.prompt });
            }

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_update_node",
                ok: true,
                nodeId,
                updatedFields,
                rerun,
            };
        }

        if (call.tool === "canvas_connect_nodes") {
            const fromNodeId = String(args.fromNodeId || "").trim();
            const toNodeId = String(args.toNodeId || "").trim();
            if (!fromNodeId || !toNodeId) return failure("canvas_connect_nodes", "invalid_args", "连线起点和终点不能为空");

            const hasFrom = snapshot.nodes.some((n) => n.id === fromNodeId);
            const hasTo = snapshot.nodes.some((n) => n.id === toNodeId);
            if (!hasFrom || !hasTo) return failure("canvas_connect_nodes", "invalid_args", "指定的连线节点不存在");

            const ops: CanvasAgentOp[] = [
                {
                    type: "connect_nodes",
                    fromNodeId,
                    toNodeId,
                },
            ];

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_connect_nodes",
                ok: true,
                fromNodeId,
                toNodeId,
            };
        }

        if (call.tool === "canvas_delete_nodes") {
            const nodeIds = Array.isArray(args.nodeIds) && args.nodeIds.length ? (args.nodeIds as string[]) : snapshot.selectedNodeIds || [];
            if (!nodeIds.length) {
                return failure("canvas_delete_nodes", "invalid_args", "未指定要删除的节点且当前未选中任何节点");
            }

            const ops: CanvasAgentOp[] = [
                {
                    type: "delete_node",
                    ids: nodeIds,
                },
            ];

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_delete_nodes",
                ok: true,
                deletedCount: nodeIds.length,
                deletedIds: nodeIds,
            };
        }

        if (call.tool === "canvas_focus_nodes") {
            const targetIds = Array.isArray(args.nodeIds) && args.nodeIds.length ? (args.nodeIds as string[]) : snapshot.nodes.map((n) => n.id);
            const newViewport = computeNodesBoundingViewport(targetIds, snapshot.nodes);
            if (!newViewport) {
                return failure("canvas_focus_nodes", "invalid_args", "画布中无可用节点以供聚焦");
            }

            const ops: CanvasAgentOp[] = [
                {
                    type: "set_viewport",
                    viewport: newViewport,
                },
            ];

            canvasContext.applyOps(ops);

            return {
                tool: "canvas_focus_nodes",
                ok: true,
                focusedCount: targetIds.length,
            };
        }

        return failure(call.tool, "unsupported", `未处理的工具: ${call.tool}`);
    } catch (error) {
        return failure(call.tool, "execution_failed", error instanceof Error ? error.message : String(error));
    }
}
