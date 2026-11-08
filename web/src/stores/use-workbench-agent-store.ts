import { create } from "zustand";

// The Agent panel dispatches commands through this store to set workbench prompts and optionally start generation.
// The panel writes model, quality, size, count, and other options to use-config-store, which workbench pages read directly.
// Prompt and run are sent here; pages identify new commands by nonce and call clear after consuming them.
// Every command also carries origin/session/project attribution plus createdAt, so a page must validate freshness
// and ownership before overwriting a prompt the user already typed (see resolveImageCommand).

export type WorkbenchCommandOrigin = "conversation" | "site-tool" | "unknown";

export type WorkbenchCommandPage = "image" | "video" | "chat" | "canvas" | "unknown";

/** 工作台命令的最长有效期：超时仍未消费的指令视为残留，消费端直接丢弃，避免旧会话的提示词被延迟执行。 */
export const WORKBENCH_COMMAND_TTL_MS = 10 * 60 * 1000;

export type WorkbenchCommand = {
    nonce: number;
    taskId?: string;
    prompt?: string;
    run: boolean;
    origin: WorkbenchCommandOrigin;
    page: WorkbenchCommandPage;
    sessionId?: string;
    canvasProjectId?: string;
    createdAt: number;
};

/** dispatch 入参：归属字段可省略，由 store 补齐默认值，既有调用方无需全部改造。 */
export type WorkbenchCommandInput = {
    prompt?: string;
    run: boolean;
    origin?: WorkbenchCommandOrigin;
    page?: WorkbenchCommandPage;
    sessionId?: string;
    canvasProjectId?: string;
};

export type WorkbenchGenerationTask = {
    id: string;
    kind: "image" | "video";
    status: "queued" | "running" | "succeeded" | "failed";
    prompt?: string;
    createdAt: string;
    updatedAt: string;
    successCount?: number;
    failCount?: number;
    error?: string;
};

/** 把浏览器路径映射成命令归属页面，供助手工具写入归属时使用。 */
export function resolveWorkbenchPage(pathname: string): WorkbenchCommandPage {
    const path = (pathname || "").split(/[?#]/)[0];
    if (path === "/image" || path.startsWith("/image/")) return "image";
    if (path === "/video" || path.startsWith("/video/")) return "video";
    if (path === "/chat" || path.startsWith("/chat/")) return "chat";
    if (path === "/canvas" || path.startsWith("/canvas/")) return "canvas";
    return "unknown";
}

export function isWorkbenchCommandExpired(command: Pick<WorkbenchCommand, "createdAt">, now = Date.now()): boolean {
    return !Number.isFinite(command.createdAt) || now - command.createdAt > WORKBENCH_COMMAND_TTL_MS;
}

export type ImageCommandResolution =
    | { action: "ignore"; reason: "expired" | "missing-prompt"; run: false; requiresConfirm: false }
    | { action: "apply"; prompt: string; run: boolean; requiresConfirm: boolean };

export type ResolveImageCommandContext = {
    /** 消费时输入框里的提示词，用于判断是否会覆盖用户已经输入的内容。 */
    currentPrompt: string;
    /** 当前页面归属，生图工作台固定传 "image"。 */
    currentPage?: WorkbenchCommandPage;
    /** 当前激活的对话会话 id，用于识别跨会话命令。 */
    activeSessionId?: string | null;
    now?: number;
};

/**
 * 决定一条 imageCommand 在生图工作台里应如何处理：
 * - 过期指令直接丢弃（不自动出图、也不覆盖输入框）；
 * - prompt 缺省时即使 run=true 也不自动出图（避免拿输入框里的残留提示词直接跑）；
 * - 来自其他页面/其他会话的指令，只有输入框为空时才允许直接落笔，
 *   否则返回 requiresConfirm=true，由调用方二次确认后再覆盖。
 */
export function resolveImageCommand(command: WorkbenchCommand, context: ResolveImageCommandContext): ImageCommandResolution {
    if (isWorkbenchCommandExpired(command, context.now)) return { action: "ignore", reason: "expired", run: false, requiresConfirm: false };
    const prompt = typeof command.prompt === "string" && command.prompt.trim() ? command.prompt : undefined;
    if (!prompt) return { action: "ignore", reason: "missing-prompt", run: false, requiresConfirm: false };
    const page = command.page || "unknown";
    const crossPage = page !== (context.currentPage || "unknown");
    const activeSessionId = context.activeSessionId || null;
    const crossSession = Boolean(command.sessionId && activeSessionId && command.sessionId !== activeSessionId);
    const currentPrompt = context.currentPrompt.trim();
    const requiresConfirm = (crossPage || crossSession) && Boolean(currentPrompt) && currentPrompt !== prompt.trim();
    return { action: "apply", prompt, run: command.run, requiresConfirm };
}

type WorkbenchAgentStore = {
    imageCommand: WorkbenchCommand | null;
    videoCommand: WorkbenchCommand | null;
    tasks: WorkbenchGenerationTask[];
    dispatchImage: (command: WorkbenchCommandInput) => string | undefined;
    dispatchVideo: (command: WorkbenchCommandInput) => string | undefined;
    updateTask: (id: string, patch: Partial<Pick<WorkbenchGenerationTask, "status" | "successCount" | "failCount" | "error">>) => void;
    clearImageCommand: () => void;
    clearVideoCommand: () => void;
};

let nonce = 0;
const nextNonce = () => (nonce += 1);

export const useWorkbenchAgentStore = create<WorkbenchAgentStore>((set) => ({
    imageCommand: null,
    videoCommand: null,
    tasks: [],
    dispatchImage: (command) => {
        const commandNonce = nextNonce();
        const normalized = normalizeCommand(command, commandNonce);
        const task = normalized.run && normalized.prompt ? createTask("image", commandNonce, normalized.prompt) : undefined;
        set((state) => ({ imageCommand: { ...normalized, taskId: task?.id }, tasks: task ? [task, ...state.tasks].slice(0, 30) : state.tasks }));
        return task?.id;
    },
    dispatchVideo: (command) => {
        const commandNonce = nextNonce();
        const normalized = normalizeCommand(command, commandNonce);
        // 视频工作台不在本项修复范围，保持原有任务记录行为，仅补齐归属字段。
        const task = normalized.run ? createTask("video", commandNonce, normalized.prompt) : undefined;
        set((state) => ({ videoCommand: { ...normalized, taskId: task?.id }, tasks: task ? [task, ...state.tasks].slice(0, 30) : state.tasks }));
        return task?.id;
    },
    updateTask: (id, patch) => set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task)) })),
    clearImageCommand: () => set({ imageCommand: null }),
    clearVideoCommand: () => set({ videoCommand: null }),
}));

function normalizeCommand(command: WorkbenchCommandInput, commandNonce: number): WorkbenchCommand {
    return {
        nonce: commandNonce,
        prompt: command.prompt,
        run: command.run,
        origin: command.origin || "unknown",
        page: command.page || "unknown",
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.canvasProjectId ? { canvasProjectId: command.canvasProjectId } : {}),
        createdAt: Date.now(),
    };
}

function createTask(kind: "image" | "video", commandNonce: number, prompt?: string): WorkbenchGenerationTask {
    const now = new Date().toISOString();
    return { id: `${kind}-${commandNonce}`, kind, status: "queued", prompt, createdAt: now, updatedAt: now };
}
