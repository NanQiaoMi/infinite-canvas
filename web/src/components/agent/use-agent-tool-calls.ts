import type { RefObject } from "react";
import type { NavigateFunction } from "react-router-dom";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { extractCanvasProjectId, isSiteTool, runSiteTool, waitForCanvasProjectReady } from "@/lib/agent/agent-site-tools";
import { postState, postToolResult } from "@/services/api/canvas-agent";
import { uploadImage } from "@/services/image-storage";
import { useAgentStore, type AgentCanvasContext, type AgentPendingToolCall } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isCanvasWriteTool, toolName } from "./agent-event-formatters";
import { rt } from "./agent-panel-utils";

export function useAgentToolCalls({ endpoint, clientIdRef, canvasContextRef, pendingToolRef, confirmToolsRef, navigate, addEventLog }: {
    endpoint: string;
    clientIdRef: RefObject<string>;
    canvasContextRef: RefObject<AgentCanvasContext | null>;
    pendingToolRef: RefObject<AgentPendingToolCall | null>;
    confirmToolsRef: RefObject<boolean>;
    navigate: NavigateFunction;
    addEventLog: (title: string, text: unknown, raw?: unknown) => void;
}) {
    const token = useAgentStore((state) => state.token);
    const pendingTool = useAgentStore((state) => state.pendingTool);
    const setAgentState = useAgentStore((state) => state.setAgentState);

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && isCanvasWriteTool(payload.name)) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: rt("pendingCanvasTool") });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog(rt("awaitingConfirmation"), payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, {
                    canvasSnapshot: canvasContextRef.current?.snapshot || null,
                    canvasContext: canvasContextRef.current,
                    syncCanvasState: (snapshot) => void postState(endpoint, token, clientIdRef.current, snapshot),
                });
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
                const logResult = sanitizeToolResultForLog(result);
                addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), logResult, logResult);
            } catch (error) {
                const message = error instanceof Error ? error.message : rt("toolExecutionFailed");
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                const path = input.path || "/";
                const targetProjectId = extractCanvasProjectId(path);
                const { projects, hydrated } = useCanvasStore.getState();
                if (targetProjectId && hydrated && !projects.some((project) => project.id === targetProjectId)) throw new Error(rt("canvasNotFound", { id: targetProjectId }));
                navigate(path);
                if (targetProjectId) {
                    const readyContext = await waitForCanvasProjectReady(
                        targetProjectId,
                        () => canvasContextRef.current ?? useAgentStore.getState().canvasContext,
                    );
                    if (readyContext) {
                        await postState(endpoint, token, clientIdRef.current, readyContext.snapshot);
                        result = {
                            ok: true,
                            path,
                            canvasReady: true,
                            projectId: readyContext.snapshot.projectId,
                            title: readyContext.snapshot.title,
                            nodeCount: readyContext.snapshot.nodes.length,
                        };
                    } else {
                        result = {
                            ok: true,
                            path,
                            canvasReady: false,
                            warning: "画布尚未完成加载，请稍候重试或检查画布 ID 是否有效",
                        };
                    }
                } else {
                    result = { ok: true, path };
                }
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                result = context.applyOps(appliedOps);
                void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error(rt("openCanvasFirst"));
                result = snapshot;
            }
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
        } catch (error) {
            const message = error instanceof Error ? error.message : rt("canvasOperationFailed");
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: rt("canvasToolCanceled") });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    return { handleToolCall, rejectPendingTool, approvePendingTool };
}

function sanitizeToolResultForLog(result: unknown): unknown {
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray((result as { _mcpImages?: unknown })._mcpImages)) {
        return result;
    }
    const { _mcpImages, ...rest } = result as Record<string, unknown> & { _mcpImages: unknown[] };
    return { ...rest, attachedImages: _mcpImages.length };
}

async function attachmentNodeOps(endpoint: string, token: string, clientId: string, value: unknown): Promise<CanvasAgentOp[]> {
    const nodes = Array.isArray(value) ? value : [];
    if (!nodes.length) throw new Error(rt("noImageAttachments"));
    return await Promise.all(
        nodes.map(async (value) => {
            const item = value as { id?: unknown; attachmentId?: unknown; title?: unknown; position?: unknown };
            const id = String(item.id || "");
            const attachmentId = String(item.attachmentId || "");
            if (!id || !attachmentId) throw new Error(rt("invalidAttachmentNode"));
            const res = await fetch(`${endpoint}/agent/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error || rt("attachmentReadFailed"));
            }
            const image = await uploadImage(await res.blob());
            const size = fitNodeSize(image.width, image.height);
            const position = item.position && typeof item.position === "object" ? (item.position as { x?: unknown; y?: unknown }) : {};
            return {
                type: "add_node" as const,
                id,
                nodeType: "image" as const,
                title: String(item.title || rt("referenceImage")),
                position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(image),
            };
        }),
    );
}
