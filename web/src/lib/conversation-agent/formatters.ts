import i18n from "@/i18n";
import type { AgentIntent } from "./intent";
import type { AgentToolCall } from "./types";

export function getInitialUnderstandStepLabel(text: string, intent?: AgentIntent): string {
    const t = (key: string, options?: Record<string, unknown>) => i18n.t(`chat.${key}`, options);
    if (intent?.isCanvas && intent?.decompose) {
        return `拆解画布任务 · 规划多节点并排排布`;
    }
    if (intent?.isCanvas) {
        return `分析画布需求 · 规划生图节点`;
    }
    if (intent?.usageScene && intent?.decompose) {
        return `分析用途【${intent.usageScene}】· 拆解图层与规格`;
    }
    if (intent?.decompose) {
        return `拆解任务需求 · 规划多图层素材与画幅`;
    }
    if (intent?.usageScene) {
        return `分析业务用途【${intent.usageScene}】· 构图与视觉定位`;
    }
    const defaultUnderstand = t("steps.understand", { defaultValue: "理解创作需求" });
    return text ? `${defaultUnderstand} · "${text.slice(0, 24)}"` : defaultUnderstand;
}

export function formatAgentToolStepLabel(call: AgentToolCall): string {
    const t = (key: string, options?: Record<string, unknown>) => i18n.t(`chat.${key}`, options);

    const canvasToolLabels: Record<string, string> = {
        canvas_get_context: "读取画布状态",
        canvas_create_image_node: "在画布创建生图节点",
        canvas_batch_generate_nodes: "在画布批量排布生成",
        canvas_create_text_node: "在画布创建文本便签",
        canvas_update_node: "更新画布节点",
        canvas_connect_nodes: "建立画布节点连线",
        canvas_delete_nodes: "删除画布节点",
        canvas_focus_nodes: "聚焦视口",
    };

    if (canvasToolLabels[call.tool]) {
        const label = canvasToolLabels[call.tool];
        if (call.tool === "canvas_batch_generate_nodes") {
            const count = Array.isArray(call.arguments.tasks) ? call.arguments.tasks.length : 0;
            return count ? `${label} · ${count} 个节点` : label;
        }
        const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
        const title = typeof call.arguments.title === "string" ? call.arguments.title : "";
        const text = typeof call.arguments.text === "string" ? call.arguments.text : "";
        const summary = prompt || title || text;
        return summary ? `${label} · "${summary.slice(0, 24)}"` : label;
    }

    const defaultNames: Record<string, string> = {
        generate_image: t("tools.names.generate_image"),
        edit_image: t("tools.names.edit_image"),
        apply_prompt: t("tools.names.apply_prompt"),
    };

    const label = defaultNames[call.tool] || call.tool;
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const size = typeof call.arguments.size === "string" ? call.arguments.size : "";
    const meta = size ? ` ${size}` : "";
    return prompt ? `${label} · "${prompt.slice(0, 32)}"${meta}` : `${label}${meta}`;
}
