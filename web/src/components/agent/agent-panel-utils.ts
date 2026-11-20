import i18n from "@/i18n";
import { randomId } from "@/lib/utils";
import { AgentApiError } from "@/services/api/canvas-agent";
import type { AgentConversationState } from "@/stores/use-agent-store";

/** 读取 Agent 运行时文案。 */
export const rt = (key: string, options?: Record<string, unknown>) => i18n.t(`agent.runtime.${key}`, options);

export function createId() {
    return randomId();
}

export function readDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error(rt("imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

export function agentErrorState(error: unknown) {
    return error instanceof AgentApiError ? (error.response as { state?: AgentConversationState }).state : undefined;
}

/** 连接状态颜色：失败红、已连接绿、连接中橙，其余用静默文字色。 */
export function connectionColor({ connectError, connected, enabled }: { connectError: string; connected: boolean; enabled: boolean }, muted: string) {
    return connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : muted;
}
