import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type LayoutMode = "grid" | "horizontal" | "vertical";

export const DEFAULT_NODE_SIZE = { width: 340, height: 240 };
const GAP_X = 48;
const GAP_Y = 48;

/**
 * 计算单个新节点的最佳放置坐标，避免与现有节点重合。
 * 规则：
 * 1. 若画布无节点，以视口中心作为参考；
 * 2. 若已有节点，默认放置在已有节点右侧，若超出合理横向宽度（如 3 列）则折行放置在下方。
 */
export function computeNextNodePosition(
    existingNodes: CanvasNodeData[],
    viewport?: ViewportTransform,
    nodeSize: { width: number; height: number } = DEFAULT_NODE_SIZE,
): { x: number; y: number } {
    if (!existingNodes || existingNodes.length === 0) {
        if (viewport) {
            // 默认容器大约为 1200x800，视口中心转换到画布坐标
            const approxWidth = 1200;
            const approxHeight = 800;
            const centerX = (-viewport.x + approxWidth / 2) / (viewport.zoom || 1);
            const centerY = (-viewport.y + approxHeight / 2) / (viewport.zoom || 1);
            return {
                x: Math.round(centerX - nodeSize.width / 2),
                y: Math.round(centerY - nodeSize.height / 2),
            };
        }
        return { x: 120, y: 120 };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of existingNodes) {
        const x = node.position?.x ?? 0;
        const y = node.position?.y ?? 0;
        const w = node.width || DEFAULT_NODE_SIZE.width;
        const h = node.height || DEFAULT_NODE_SIZE.height;

        if (x < minX) minX = x;
        if (x + w > maxX) maxX = x + w;
        if (y < minY) minY = y;
        if (y + h > maxY) maxY = y + h;
    }

    // 默认放到现有节点右侧
    return {
        x: Math.round(maxX + GAP_X),
        y: Math.round(minY),
    };
}

/**
 * 批量生成节点的智能排布坐标
 */
export function computeBatchLayoutPositions(
    count: number,
    layout: LayoutMode = "grid",
    existingNodes: CanvasNodeData[] = [],
    viewport?: ViewportTransform,
    nodeSize: { width: number; height: number } = DEFAULT_NODE_SIZE,
): Array<{ x: number; y: number }> {
    if (count <= 0) return [];

    const startPos = computeNextNodePosition(existingNodes, viewport, nodeSize);
    const positions: Array<{ x: number; y: number }> = [];

    // 列数计算：针对 grid，如果 4 张图用 2x2，6-9 张图用 3 列，10-12 张用 4 列（4x3 网格更契合宽屏）
    const cols = layout === "horizontal" ? count : layout === "vertical" ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;

    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions.push({
            x: Math.round(startPos.x + col * (nodeSize.width + GAP_X)),
            y: Math.round(startPos.y + row * (nodeSize.height + GAP_Y)),
        });
    }

    return positions;
}

/**
 * 计算包裹指定节点的聚焦视口
 */
export function computeNodesBoundingViewport(
    nodeIds: string[],
    nodes: CanvasNodeData[],
    containerSize: { width: number; height: number } = { width: 1200, height: 800 },
): ViewportTransform | null {
    const targets = (nodes || []).filter((node) => nodeIds.includes(node.id));
    if (!targets.length) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of targets) {
        const x = node.position?.x ?? 0;
        const y = node.position?.y ?? 0;
        const w = node.width || DEFAULT_NODE_SIZE.width;
        const h = node.height || DEFAULT_NODE_SIZE.height;

        if (x < minX) minX = x;
        if (x + w > maxX) maxX = x + w;
        if (y < minY) minY = y;
        if (y + h > maxY) maxY = y + h;
    }

    const bboxWidth = maxX - minX;
    const bboxHeight = maxY - minY;
    const padding = 80;

    const scaleX = (containerSize.width - padding * 2) / Math.max(10, bboxWidth);
    const scaleY = (containerSize.height - padding * 2) / Math.max(10, bboxHeight);
    const zoom = Math.max(0.1, Math.min(1.2, Math.min(scaleX, scaleY)));

    const centerX = minX + bboxWidth / 2;
    const centerY = minY + bboxHeight / 2;

    const vx = containerSize.width / 2 - centerX * zoom;
    const vy = containerSize.height / 2 - centerY * zoom;

    return { x: Math.round(vx), y: Math.round(vy), zoom: Number(zoom.toFixed(2)) };
}
