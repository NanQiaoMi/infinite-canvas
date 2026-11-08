const storeMap = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
    (globalThis as any).localStorage = {
        getItem: (k: string) => storeMap.get(k) ?? null,
        setItem: (k: string, v: string) => storeMap.set(k, String(v)),
        removeItem: (k: string) => storeMap.delete(k),
        clear: () => storeMap.clear(),
        key: (i: number) => Array.from(storeMap.keys())[i] ?? null,
        get length() {
            return storeMap.size;
        },
    };
}

import { beforeEach, describe, expect, it } from "bun:test";

import { readImageTaskEchoMismatch, type ImageTaskResult } from "../src/services/api/image-queue";
import { planWorkbenchRecovery, resolveRetrySlotSnapshot, useImageTaskStore, type PersistedImageTask } from "../src/stores/use-image-task-store";
import {
    WORKBENCH_COMMAND_TTL_MS,
    isWorkbenchCommandExpired,
    resolveImageCommand,
    resolveWorkbenchPage,
    useWorkbenchAgentStore,
    type WorkbenchCommand,
} from "../src/stores/use-workbench-agent-store";
import type { ReferenceImage } from "../src/types/image";

const CURRENT_BASE_URL = "https://api.example.com/v1";
const NOW = 1_800_000_000_000;

function makeCommand(overrides: Partial<WorkbenchCommand> = {}): WorkbenchCommand {
    return {
        nonce: 1,
        prompt: "来自对话的提示词",
        run: false,
        origin: "conversation",
        page: "chat",
        createdAt: NOW,
        ...overrides,
    };
}

function makePersistedTask(overrides: Partial<PersistedImageTask> = {}): PersistedImageTask {
    return {
        taskId: "task-1",
        source: "workbench",
        prompt: "工作台提示词",
        model: "gpt-image-2",
        baseUrl: CURRENT_BASE_URL,
        createdAt: NOW,
        updatedAt: NOW,
        status: "queued",
        slotIndex: 0,
        ...overrides,
    };
}

function makeTaskResult(overrides: Partial<ImageTaskResult> = {}): ImageTaskResult {
    return {
        task_id: "task-1",
        status: "queued",
        queue_position: 1,
        estimated_wait_seconds: 30,
        progress: 0,
        duration_seconds: 0,
        ...overrides,
    };
}

function makeReference(id: string): ReferenceImage {
    return { id, name: `${id}.png`, type: "image/png", dataUrl: `data:image/png;base64,${id}` };
}

beforeEach(() => {
    useWorkbenchAgentStore.setState({ imageCommand: null, videoCommand: null, tasks: [] });
});

describe("工作台命令归属与时效 (WorkbenchCommand)", () => {
    it("dispatchImage 写入 origin/page/sessionId/canvasProjectId/createdAt，并保留 prompt/run", () => {
        const taskId = useWorkbenchAgentStore.getState().dispatchImage({
            prompt: "赛博朋克猫",
            run: false,
            origin: "conversation",
            page: "chat",
            sessionId: "session-a",
            canvasProjectId: "project-1",
        });
        expect(taskId).toBeUndefined();
        const command = useWorkbenchAgentStore.getState().imageCommand;
        expect(command?.prompt).toBe("赛博朋克猫");
        expect(command?.run).toBe(false);
        expect(command?.origin).toBe("conversation");
        expect(command?.page).toBe("chat");
        expect(command?.sessionId).toBe("session-a");
        expect(command?.canvasProjectId).toBe("project-1");
        expect(typeof command?.createdAt).toBe("number");
    });

    it("未传归属的调用方回填 unknown，且 run=true 但无 prompt 时不创建生成任务", () => {
        const runWithoutPrompt = useWorkbenchAgentStore.getState().dispatchImage({ run: true });
        expect(runWithoutPrompt).toBeUndefined();

        useWorkbenchAgentStore.getState().dispatchImage({ prompt: "无归属", run: false });
        const command = useWorkbenchAgentStore.getState().imageCommand;
        expect(command?.origin).toBe("unknown");
        expect(command?.page).toBe("unknown");
        expect(useWorkbenchAgentStore.getState().tasks).toHaveLength(0);
    });

    it("浏览器路径映射到命令来源页面", () => {
        expect(resolveWorkbenchPage("/chat")).toBe("chat");
        expect(resolveWorkbenchPage("/chat/session-1")).toBe("chat");
        expect(resolveWorkbenchPage("/canvas/project-1?focus=node")).toBe("canvas");
        expect(resolveWorkbenchPage("/image")).toBe("image");
        expect(resolveWorkbenchPage("/video")).toBe("video");
        expect(resolveWorkbenchPage("/settings")).toBe("unknown");
    });

    it("超过 TTL 的命令判定为过期，边界内仍有效", () => {
        expect(isWorkbenchCommandExpired({ createdAt: NOW - WORKBENCH_COMMAND_TTL_MS }, NOW)).toBe(false);
        expect(isWorkbenchCommandExpired({ createdAt: NOW - WORKBENCH_COMMAND_TTL_MS - 1 }, NOW)).toBe(true);
        expect(isWorkbenchCommandExpired({ createdAt: Number.NaN }, NOW)).toBe(true);
    });
});

describe("生图命令消费归属校验 (resolveImageCommand)", () => {
    it("过期命令直接丢弃，不覆盖输入框也不自动出图", () => {
        const resolution = resolveImageCommand(makeCommand({ createdAt: NOW - WORKBENCH_COMMAND_TTL_MS - 1, run: true }), {
            currentPrompt: "",
            currentPage: "image",
            now: NOW,
        });
        expect(resolution.action).toBe("ignore");
        if (resolution.action === "ignore") expect(resolution.reason).toBe("expired");
    });

    it("prompt 缺省时 run=true 也不得自动出图", () => {
        const resolution = resolveImageCommand(makeCommand({ prompt: undefined, run: true, page: "image" }), { currentPrompt: "输入框里的旧提示词", currentPage: "image", now: NOW });
        expect(resolution.action).toBe("ignore");
        if (resolution.action === "ignore") expect(resolution.reason).toBe("missing-prompt");
    });

    it("跨页面命令覆盖非空输入框时必须二次确认", () => {
        const resolution = resolveImageCommand(makeCommand({ prompt: "对话里的提示词", page: "chat" }), {
            currentPrompt: "用户自己写的提示词",
            currentPage: "image",
            now: NOW,
        });
        expect(resolution.action).toBe("apply");
        if (resolution.action === "apply") {
            expect(resolution.prompt).toBe("对话里的提示词");
            expect(resolution.requiresConfirm).toBe(true);
        }
    });

    it("输入框为空时跨页面命令可直接落笔（没有内容被覆盖）", () => {
        const resolution = resolveImageCommand(makeCommand({ page: "chat" }), { currentPrompt: "  ", currentPage: "image", now: NOW });
        expect(resolution.action).toBe("apply");
        if (resolution.action === "apply") expect(resolution.requiresConfirm).toBe(false);
    });

    it("同页面同会话命令可直接应用；跨会话命令覆盖非空输入框需确认", () => {
        const sameSession = resolveImageCommand(makeCommand({ page: "image", sessionId: "session-a" }), {
            currentPrompt: "用户自己写的提示词",
            currentPage: "image",
            activeSessionId: "session-a",
            now: NOW,
        });
        expect(sameSession.action).toBe("apply");
        if (sameSession.action === "apply") expect(sameSession.requiresConfirm).toBe(false);

        const crossSession = resolveImageCommand(makeCommand({ page: "image", sessionId: "session-b" }), {
            currentPrompt: "用户自己写的提示词",
            currentPage: "image",
            activeSessionId: "session-a",
            now: NOW,
        });
        expect(crossSession.action).toBe("apply");
        if (crossSession.action === "apply") expect(crossSession.requiresConfirm).toBe(true);
    });

    it("命令提示词与输入框完全一致时无需确认", () => {
        const resolution = resolveImageCommand(makeCommand({ prompt: "同一个提示词", page: "chat" }), {
            currentPrompt: " 同一个提示词 ",
            currentPage: "image",
            now: NOW,
        });
        expect(resolution.action).toBe("apply");
        if (resolution.action === "apply") expect(resolution.requiresConfirm).toBe(false);
    });
});

describe("刷新恢复计划 (planWorkbenchRecovery)", () => {
    it("只恢复 workbench 未完成任务，并按持久化 slotIndex 归位", () => {
        const plan = planWorkbenchRecovery(
            [
                makePersistedTask({ taskId: "task-slot-2", slotIndex: 2 }),
                makePersistedTask({ taskId: "task-slot-0", slotIndex: 0, status: "processing" }),
                makePersistedTask({ taskId: "task-chat", source: "chat" }),
                makePersistedTask({ taskId: "task-done", status: "succeeded" }),
            ],
            { baseUrl: CURRENT_BASE_URL },
        );
        expect(plan.entries.map((entry) => entry.task.taskId)).toEqual(["task-slot-0", "task-slot-2"]);
        expect(plan.entries.map((entry) => entry.slotIndex)).toEqual([0, 2]);
        expect(plan.rejected).toHaveLength(0);
    });

    it("跨渠道任务与缺提示词任务被拒绝并给出原因", () => {
        const plan = planWorkbenchRecovery(
            [
                makePersistedTask({ taskId: "task-current" }),
                makePersistedTask({ taskId: "task-other-channel", baseUrl: "https://api.other.com/v1" }),
                makePersistedTask({ taskId: "task-no-base-url", baseUrl: undefined }),
                makePersistedTask({ taskId: "task-no-prompt", prompt: "   " }),
            ],
            { baseUrl: CURRENT_BASE_URL },
        );
        expect(plan.entries.map((entry) => entry.task.taskId)).toEqual(["task-current"]);
        const rejectionReasons = Object.fromEntries(plan.rejected.map((entry) => [entry.task.taskId, entry.reason]));
        expect(rejectionReasons["task-other-channel"]).toBe("channel-mismatch");
        expect(rejectionReasons["task-no-base-url"]).toBe("channel-mismatch");
        expect(rejectionReasons["task-no-prompt"]).toBe("missing-prompt");
    });

    it("baseUrl 尾部斜杠/大小写差异视为同一渠道；重复 slotIndex 顺延避免撞位", () => {
        const plan = planWorkbenchRecovery(
            [
                makePersistedTask({ taskId: "task-a", baseUrl: "HTTPS://API.EXAMPLE.COM/v1/", slotIndex: 0 }),
                makePersistedTask({ taskId: "task-b", slotIndex: 0 }),
            ],
            { baseUrl: CURRENT_BASE_URL },
        );
        expect(plan.entries).toHaveLength(2);
        expect(plan.entries.map((entry) => entry.slotIndex)).toEqual([0, 1]);
    });
});

describe("失败槽位重试快照 (resolveRetrySlotSnapshot)", () => {
    it("使用槽位自身的 prompt/references 快照", () => {
        const reference = makeReference("ref-1");
        const snapshot = resolveRetrySlotSnapshot({ prompt: "旧批次提示词", references: [reference] });
        expect(snapshot?.prompt).toBe("旧批次提示词");
        expect(snapshot?.references).toHaveLength(1);
        expect(snapshot?.references[0].id).toBe("ref-1");
        // 返回副本，重试过程修改数组不会影响结果卡片上的快照
        snapshot?.references.push(makeReference("ref-2"));
        expect(snapshot?.references).toHaveLength(2);
    });

    it("槽位缺少 prompt 快照时拒绝重试，不回落到输入框当前提示词", () => {
        expect(resolveRetrySlotSnapshot({ references: [] })).toBeNull();
        expect(resolveRetrySlotSnapshot({ prompt: "   " })).toBeNull();
        expect(resolveRetrySlotSnapshot(undefined)).toBeNull();
    });
});

describe("服务端 task 回显校验 (readImageTaskEchoMismatch)", () => {
    it("回显 prompt/model 与本地记录一致时不报错（含改图追加参考图文本、渠道前缀）", () => {
        expect(readImageTaskEchoMismatch(makeTaskResult({ prompt: "一只胖橘猫", model: "gpt-image-2" }), { prompt: "一只胖橘猫", model: "gpt-image-2" })).toBeNull();
        expect(readImageTaskEchoMismatch(makeTaskResult({ prompt: "一只胖橘猫 [参考图1]" }), { prompt: "一只胖橘猫" })).toBeNull();
        expect(readImageTaskEchoMismatch(makeTaskResult({ model: "channel-a::gpt-image-2" }), { model: "gpt-image-2" })).toBeNull();
    });

    it("回显 prompt/model 不一致时返回错误信息，避免 task_id 张冠李戴", () => {
        const promptMismatch = readImageTaskEchoMismatch(makeTaskResult({ prompt: "另一张图" }), { prompt: "一只胖橘猫" });
        expect(promptMismatch).toBeTruthy();
        expect(promptMismatch).toContain("提示词");

        const modelMismatch = readImageTaskEchoMismatch(makeTaskResult({ model: "dall-e-3" }), { model: "gpt-image-2" });
        expect(modelMismatch).toBeTruthy();
        expect(modelMismatch).toContain("模型");
    });

    it("服务端未回显 prompt/model 时跳过校验（兼容不返回回显的队列服务）", () => {
        expect(readImageTaskEchoMismatch(makeTaskResult(), { prompt: "本地提示词", model: "gpt-image-2" })).toBeNull();
    });
});

describe("恢复任务持久化字段", () => {
    it("registerActiveTask 保存 baseUrl 渠道指纹与 slotIndex，供刷新恢复校验", () => {
        const store = useImageTaskStore.getState();
        store.registerActiveTask({
            taskId: "task-persist-1",
            source: "workbench",
            prompt: "持久化提示词",
            model: "gpt-image-2",
            baseUrl: CURRENT_BASE_URL,
            createdAt: NOW,
            status: "processing",
            slotIndex: 3,
        });
        const task = store.getTask("task-persist-1");
        expect(task?.baseUrl).toBe(CURRENT_BASE_URL);
        expect(task?.slotIndex).toBe(3);
        store.removeActiveTask("task-persist-1");
    });
});
