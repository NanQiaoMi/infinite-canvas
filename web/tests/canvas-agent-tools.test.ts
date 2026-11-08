import { describe, expect, it, beforeEach } from "bun:test";

const values = new Map<string, string>();
if (!globalThis.localStorage) {
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        },
    });
}

const {
    computeBatchLayoutPositions,
    computeNextNodePosition,
    computeNodesBoundingViewport,
} = await import("../src/lib/canvas/canvas-layout-planner");

const {
    CANVAS_AGENT_TOOLS,
    executeCanvasAgentTool,
    isCanvasTool,
} = await import("../src/lib/conversation-agent/canvas-tools");

const { serializeToolResult } = await import("../src/lib/conversation-agent/protocol");
const { ALL_AGENT_TOOLS, executeAgentTool } = await import("../src/lib/conversation-agent/tools");
const { useAgentStore } = await import("../src/stores/use-agent-store");
const { applyCanvasAgentOps } = await import("../src/lib/canvas/canvas-agent-ops");
const { CanvasNodeType } = await import("../src/types/canvas");
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";
import type { CanvasNodeData } from "../src/types/canvas";

describe("画布智能布局规划器 (canvas-layout-planner)", () => {
    it("空画布无节点时，根据视口中心自动计算节点放置位置", () => {
        const viewport = { x: 0, y: 0, zoom: 1 };
        const pos = computeNextNodePosition([], viewport, { width: 340, height: 240 });
        // approxWidth 1200 / 2 - 170 = 430, approxHeight 800 / 2 - 120 = 280
        expect(pos.x).toBe(430);
        expect(pos.y).toBe(280);
    });

    it("已有节点时，新节点自动排布在右侧安全距离，避免重叠", () => {
        const existing: CanvasNodeData[] = [
            {
                id: "node-1",
                type: CanvasNodeType.Image,
                title: "图1",
                position: { x: 100, y: 100 },
                width: 340,
                height: 240,
            },
        ];
        const nextPos = computeNextNodePosition(existing);
        // 100 + 340 + 48 = 488
        expect(nextPos.x).toBe(488);
        expect(nextPos.y).toBe(100);
    });

    it("批量生成节点时，网格/并排坐标计算正确", () => {
        const positions = computeBatchLayoutPositions(4, "grid", []);
        expect(positions.length).toBe(4);
        // 2x2 网格
        expect(positions[0].y).toBe(positions[1].y);
        expect(positions[2].y).toBe(positions[3].y);
        expect(positions[2].y).toBeGreaterThan(positions[0].y);
        expect(positions[1].x).toBeGreaterThan(positions[0].x);

        // 12 个节点使用 4 列 x 3 行网格
        const positions12 = computeBatchLayoutPositions(12, "grid", []);
        expect(positions12.length).toBe(12);
        expect(positions12[0].y).toBe(positions12[3].y); // 第 1 行 4 个节点同一高度
        expect(positions12[4].y).toBe(positions12[7].y); // 第 2 行
        expect(positions12[8].y).toBe(positions12[11].y); // 第 3 行
        expect(positions12[4].y).toBeGreaterThan(positions12[0].y);
        expect(positions12[8].y).toBeGreaterThan(positions12[4].y);
    });

    it("计算包裹指定节点的视口变换并平滑缩放", () => {
        const nodes: CanvasNodeData[] = [
            { id: "n1", type: CanvasNodeType.Image, title: "1", position: { x: 0, y: 0 }, width: 300, height: 200 },
            { id: "n2", type: CanvasNodeType.Image, title: "2", position: { x: 400, y: 0 }, width: 300, height: 200 },
        ];
        const vp = computeNodesBoundingViewport(["n1", "n2"], nodes, { width: 1200, height: 800 });
        expect(vp).not.toBeNull();
        expect(vp!.k).toBeGreaterThan(0);
        expect(vp!.k).toBeLessThanOrEqual(1.2);
    });
});

describe("画布专属工具集 (Canvas Agent Tools)", () => {
    let mockSnapshot: CanvasAgentSnapshot;
    let appliedOps: CanvasAgentOp[];

    beforeEach(() => {
        appliedOps = [];
        mockSnapshot = {
            projectId: "proj-123",
            title: "测试画布工程",
            nodes: [
                {
                    id: "existing-1",
                    type: CanvasNodeType.Image,
                    title: "已有图片",
                    position: { x: 50, y: 50 },
                    width: 340,
                    height: 240,
                    metadata: { prompt: "风景画", content: "data:image/png;base64,123" },
                },
            ],
            connections: [],
            selectedNodeIds: ["existing-1"],
            viewport: { x: 0, y: 0, zoom: 1 },
        };

        useAgentStore.setState({
            canvasContext: {
                snapshot: mockSnapshot,
                applyOps: (ops) => {
                    if (ops) appliedOps.push(...ops);
                    const next = applyCanvasAgentOps(mockSnapshot, ops);
                    mockSnapshot = next;
                    useAgentStore.setState((s) => ({
                        canvasContext: s.canvasContext ? { ...s.canvasContext, snapshot: next } : null,
                    }));
                    return next;
                },
                undoOps: () => null,
                canUndo: false,
            },
        });
    });

    it("工具识别：正确区分普通工具与画布工具", () => {
        expect(isCanvasTool("canvas_create_image_node")).toBe(true);
        expect(isCanvasTool("canvas_batch_generate_nodes")).toBe(true);
        expect(isCanvasTool("generate_image")).toBe(false);
        expect(isCanvasTool("edit_image")).toBe(false);
    });

    it("canvas_get_context：获取当前画布完整上下文", async () => {
        const res = await executeCanvasAgentTool({
            tool: "canvas_get_context",
            arguments: {},
        });
        expect(res.ok).toBe(true);
        if (res.ok && res.tool === "canvas_get_context") {
            expect(res.projectId).toBe("proj-123");
            expect(res.nodeCount).toBe(1);
            expect(res.nodes[0].title).toBe("已有图片");
            expect(res.nodes[0].hasImage).toBe(true);
            expect(res.selectedNodeIds).toContain("existing-1");
        }
    });

    it("canvas_create_image_node：创建单个生图节点并启动生成", async () => {
        const res = await executeCanvasAgentTool({
            tool: "canvas_create_image_node",
            arguments: {
                prompt: "未来科幻战士，电影级光影，9:16 全身特写",
                title: "战士角色",
                background: "transparent",
            },
        });

        expect(res.ok).toBe(true);
        if (res.ok && res.tool === "canvas_create_image_node") {
            expect(res.title).toBe("战士角色");
            expect(res.size).toBe("864x1536"); // 自适应推断 9:16
            expect(res.position.x).toBeGreaterThan(50); // 自动排在右侧
        }

        // 检查 ops
        const addOp = appliedOps.find((op) => op.type === "add_node");
        const runOp = appliedOps.find((op) => op.type === "run_generation");
        expect(addOp).toBeDefined();
        expect(addOp?.nodeType).toBe("image");
        expect(addOp?.metadata?.background).toBe("transparent");
        expect(runOp).toBeDefined();
    });

    it("canvas_batch_generate_nodes：批量创建多个生图节点并在画布排开", async () => {
        const tasks = [
            { prompt: "苹果透明底图标", title: "苹果", background: "transparent" as const },
            { prompt: "香蕉透明底图标", title: "香蕉", background: "transparent" as const },
            { prompt: "葡萄透明底图标", title: "葡萄", background: "transparent" as const },
        ];

        const res = await executeCanvasAgentTool({
            tool: "canvas_batch_generate_nodes",
            arguments: {
                tasks,
                layout: "horizontal",
                run: true,
            },
        });

        expect(res.ok).toBe(true);
        if (res.ok && res.tool === "canvas_batch_generate_nodes") {
            expect(res.count).toBe(3);
            expect(res.nodes.length).toBe(3);
            // 横向并排
            expect(res.nodes[1].position.x).toBeGreaterThan(res.nodes[0].position.x);
            expect(res.nodes[2].position.x).toBeGreaterThan(res.nodes[1].position.x);
        }

        const addOps = appliedOps.filter((op) => op.type === "add_node");
        const runOps = appliedOps.filter((op) => op.type === "run_generation");
        expect(addOps.length).toBe(3);
        expect(runOps.length).toBe(3);

        // 验证支持批量排布最多 12 个节点
        const tasks12 = Array.from({ length: 12 }, (_, i) => ({
            prompt: `生肖图标 ${i + 1}`,
            title: `生肖 ${i + 1}`,
        }));
        const res12 = await executeCanvasAgentTool({
            tool: "canvas_batch_generate_nodes",
            arguments: { tasks: tasks12, layout: "grid", run: true },
        });
        expect(res12.ok).toBe(true);
        if (res12.ok && res12.tool === "canvas_batch_generate_nodes") {
            expect(res12.count).toBe(12);
            expect(res12.nodes.length).toBe(12);
        }
    });

    it("canvas_create_text_node 与 canvas_connect_nodes：创建便签并连线", async () => {
        const textRes = await executeCanvasAgentTool({
            tool: "canvas_create_text_node",
            arguments: {
                text: "这是海报的整体设计风格指南：赛博朋克深蓝与荧光橙配色",
                title: "设计指南",
            },
        });
        expect(textRes.ok).toBe(true);
        let textNodeId = "";
        if (textRes.ok && textRes.tool === "canvas_create_text_node") {
            textNodeId = textRes.nodeId;
        }

        const connRes = await executeCanvasAgentTool({
            tool: "canvas_connect_nodes",
            arguments: {
                fromNodeId: textNodeId,
                toNodeId: "existing-1",
            },
        });
        expect(connRes.ok).toBe(true);

        const connOp = appliedOps.find((op) => op.type === "connect_nodes");
        expect(connOp).toBeDefined();
    });

    it("canvas_update_node：更新已有节点并重新生成", async () => {
        const res = await executeCanvasAgentTool({
            tool: "canvas_update_node",
            arguments: {
                nodeId: "existing-1",
                prompt: "更新后的超清赛博朋克风景",
                title: "赛博风景",
                rerun: true,
            },
        });
        expect(res.ok).toBe(true);
        if (res.ok && res.tool === "canvas_update_node") {
            expect(res.updatedFields).toContain("prompt");
            expect(res.updatedFields).toContain("title");
            expect(res.rerun).toBe(true);
        }

        const updateOp = appliedOps.find((op) => op.type === "update_node");
        const runOp = appliedOps.find((op) => op.type === "run_generation");
        expect(updateOp).toBeDefined();
        expect(runOp).toBeDefined();
    });

    it("canvas_delete_nodes：删除指定节点或选区", async () => {
        const res = await executeCanvasAgentTool({
            tool: "canvas_delete_nodes",
            arguments: {},
        });
        expect(res.ok).toBe(true);
        if (res.ok && res.tool === "canvas_delete_nodes") {
            expect(res.deletedIds).toContain("existing-1");
        }

        const deleteOp = appliedOps.find((op) => op.type === "delete_node");
        expect(deleteOp).toBeDefined();
    });

    it("executeAgentTool 统一分发至画布工具并可正确序列化", async () => {
        const call = {
            tool: "canvas_create_text_node",
            arguments: { text: "灵感备忘", title: "备忘" },
        };
        const res = await executeAgentTool(call, { signal: new AbortController().signal });
        expect(res.ok).toBe(true);

        const serialized = serializeToolResult(call, res);
        expect(serialized).toContain('<tool_result name="canvas_create_text_node" status="ok">');
        expect(serialized).toContain("灵感备忘");
    });
});
