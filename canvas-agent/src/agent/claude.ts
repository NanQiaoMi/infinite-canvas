import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { archiveSession, getSessionInfo, listSessions, query, type CanUseTool, type EffortLevel, type Options, type PermissionMode, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKSessionInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import matter from "gray-matter";

import { AGENT_PROMPT, CONFIG_DIR } from "../config.js";
import { SkillStore } from "../skills/store.js";
import { logger } from "../utils/logger.js";
import { errorMessage, field, type JsonRecord } from "../utils/value.js";
import { canvasAgentMcp } from "./codex-client.js";
import { CodexEventHistory } from "./codex-event-history.js";
import { settledTurnIds, summarizeCodexThread, threadMessages } from "./codex-history.js";
import { CodexSkillLookupError, parseSkillDraft, samePath, SKILL_DRAFT_OUTPUT_SCHEMA, skillDraftPrompt, type CodexSkillDraftInput } from "./codex.js";
import type { CodexPlanStep, CodexReasoningEffort, CodexSkillMetadata, CodexSkillSelector, CodexSkillsListEntry } from "./codex-protocol.js";
import { messageMetadataStore } from "./message-metadata.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "./types.js";

type ClaudeRunOptions = { threadId?: string; cwd?: string; permissionMode?: AgentPermissionMode; model?: string; effort?: CodexReasoningEffort; skill?: CodexSkillSelector; messageText?: string; appEmit?: AgentEmit; onStart?: () => void; onThread?: (threadId: string) => void; onTurn?: (turnId: string) => void; onFinish?: () => void };
type ActiveTurn = { threadId: string; turnId: string; query?: Query; interrupted: boolean };
type PendingApproval = { resolve: (result: PermissionResult) => void; suggestions?: PermissionUpdate[]; input: Record<string, unknown>; emit: AgentEmit; scope: { threadId: string; turnId: string }; decision?: string };

const AGENT_TITLE = "Claude";
const CANVAS_MCP = "infinite-canvas";
const HISTORY_DIR = path.join(CONFIG_DIR, "claude-history");
const SKILL_STATE_FILE = path.join(CONFIG_DIR, "claude-skills.json");
const SKILL_DRAFT_INSTRUCTIONS = "你只负责根据已提供的对话或画布快照生成可编辑的 Claude Skill 草稿。不要调用任何工具，不要执行命令，不要读取文件，不要访问网络，不要修改任何状态。严格按输出结构返回结果，并排除凭证、密钥、Token、本地路径、临时错误、调试日志和一次性结果。";
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** 画布 MCP 启动等待上限，与 Codex 侧 infinite-canvas 的 startup_timeout_sec 保持一致。 */
const MCP_STARTUP_TIMEOUT_MS = 20_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let claudeQueue: Promise<unknown> = Promise.resolve();
let activeTurn: ActiveTurn | null = null;
let cachedModels: Promise<{ data: JsonRecord[] }> | null = null;
const histories = new Map<string, CodexEventHistory>();
const draftThreads = new Map<string, { cwd: string; createdAt: number }>();
const approvals = new Map<string, PendingApproval>();

/** 将 Claude turn 加入串行队列并等待执行完成。 */
export async function runClaudeTurn(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[] = [], options: ClaudeRunOptions = {}) {
    if (!prompt.trim()) return;
    claudeQueue = claudeQueue.catch(() => undefined).then(() => runClaudeTurnNow(prompt, lifecycleEmit, attachments, options));
    await claudeQueue;
}

/** 中断当前线程正在执行的 Claude turn。 */
export async function interruptClaudeTurn(threadId?: string) {
    const turn = activeTurn;
    if (!turn?.query || (threadId && threadId !== turn.threadId)) return false;
    turn.interrupted = true;
    try {
        await turn.query.interrupt();
        return true;
    } catch (error) {
        logger.warn("Failed to interrupt Claude turn", { error, threadId: turn.threadId, turnId: turn.turnId });
        return false;
    }
}

/** 回复网页端已经确认的 Claude 工具权限请求。 */
export async function resolveClaudeApproval(requestId: string, decision: string) {
    const approval = approvals.get(requestId);
    if (!approval) return false;
    if (approval.decision) return true;
    finishApproval(requestId, decision);
    return true;
}

/** 创建新的 Claude 会话；首次发送消息时才会落盘。 */
export async function startClaudeThread(emit: AgentEmit, cwd = "", _permissionMode: AgentPermissionMode = "request", preheat = false) {
    const id = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    draftThreads.set(id, { cwd, createdAt });
    if (cwd) await ensureClaudeWorkspace(cwd);
    if (preheat) await preheatMcp(emit, id, cwd);
    return { id, cwd, preview: "", createdAt, updatedAt: createdAt, status: "idle" };
}

/** 恢复指定 Claude 会话并返回聊天历史。 */
export async function resumeClaudeThread(emit: AgentEmit, threadId: string, cwd = "", _permissionMode: AgentPermissionMode = "request", preheat = false) {
    const history = await readClaudeThread(emit, threadId, cwd);
    if (cwd) await ensureClaudeWorkspace(cwd);
    if (preheat) await preheatMcp(emit, threadId, cwd);
    return history;
}

/** 读取指定 Claude 会话及其聊天历史。 */
export async function readClaudeThread(_emit: AgentEmit, threadId: string, cwd = "") {
    const info = await sessionInfo(threadId, cwd);
    const draft = draftThreads.get(threadId);
    if (!info && !draft) throw new Error(`no rollout found for thread id ${threadId}`);
    const supplemental = await historyFor(threadId).readThread(threadId);
    const thread = { id: threadId, turns: [] };
    const messages = await mergeMessageMetadata(threadId, threadMessages(thread, [], supplemental, AGENT_TITLE));
    return { thread: info ? summarizeSession(info, cwd) : { ...summarizeCodexThread({ id: threadId, cwd, createdAt: draft?.createdAt, updatedAt: draft?.createdAt }) }, messages, settledTurnIds: settledTurnIds(thread, supplemental), historyReady: true };
}

/** 查询当前工作空间中的 Claude 会话。 */
export async function listClaudeThreads(_emit: AgentEmit, options: { cwd: string; searchTerm?: string; limit?: number; cursor?: string }) {
    const term = (options.searchTerm || "").trim().toLocaleLowerCase();
    const limit = options.limit || 40;
    const offset = Math.max(0, Number(options.cursor) || 0);
    // 搜索需要覆盖全部会话，先取全量再分页；无搜索词时直接按偏移分页。
    const sessions = await listSessions({ dir: options.cwd, ...(term ? {} : { limit: limit + 1, offset }) }).catch((error) => {
        logger.warn("Failed to list Claude sessions", { error });
        return [] as SDKSessionInfo[];
    });
    const data = (term ? sessions : sessions.slice(0, limit))
        .filter((item) => !field(item, "archived") && (!item.cwd || samePath(item.cwd, options.cwd)))
        .map((item) => summarizeSession(item, options.cwd))
        .filter((item) => !term || `${item.name || ""}\n${item.preview}`.toLocaleLowerCase().includes(term));
    const page = term ? data.slice(offset, offset + limit) : data.slice(0, limit);
    const hasMore = term ? data.length > offset + limit : sessions.length > limit;
    return { data: page, nextCursor: hasMore ? String(offset + limit) : null, backwardsCursor: null };
}

/** 归档指定 Claude 会话并清理画布侧历史。 */
export async function archiveClaudeThread(_emit: AgentEmit, threadId: string, cwd = "") {
    assertThreadId(threadId);
    if (await sessionInfo(threadId, cwd)) await archiveSession(threadId, { dir: cwd });
    draftThreads.delete(threadId);
    histories.delete(threadId);
    await fs.rm(historyFile(threadId), { force: true });
    await messageMetadataStore.removeThread(threadId).catch((error) => logger.warn("Failed to remove archived thread message metadata", { threadId, error }));
}

/** 查询当前账号可用的 Claude 模型，转换为网页统一模型结构。 */
export async function listClaudeModels(_emit: AgentEmit) {
    cachedModels ||= loadClaudeModels().catch((error) => {
        cachedModels = null;
        throw error;
    });
    return await cachedModels;
}

/** 列出站点工作空间与用户目录下 Claude 可发现的 Skill。 */
export async function listClaudeSkills(_emit: AgentEmit, cwd: string, _forceReload = false): Promise<CodexSkillsListEntry> {
    await ensureClaudeWorkspace(cwd);
    const disabled = new Set(await readDisabledSkills());
    const store = new SkillStore(cwd);
    const roots = [{ dir: path.join(cwd, ".agents", "skills"), scope: "repo" as const }, { dir: path.join(os.homedir(), ".claude", "skills"), scope: "user" as const }];
    const skills: CodexSkillMetadata[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const root of roots) {
        const entries = await fs.readdir(root.dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const skillPath = path.join(root.dir, entry.name, "SKILL.md");
            try {
                const parsed = matter(await fs.readFile(skillPath, "utf8"));
                const name = String(parsed.data.name || entry.name);
                const managed = root.scope === "repo" && store.isManagedPath(skillPath) ? await store.get(name).catch(() => null) : null;
                skills.push({ name, description: String(parsed.data.description || ""), shortDescription: managed?.interface?.shortDescription || null, interface: managed?.interface || null, path: skillPath, scope: root.scope, enabled: !disabled.has(skillPath) });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
                errors.push({ path: skillPath, message: errorMessage(error) });
            }
        }
    }
    return { cwd, skills, errors };
}

/** 从 Claude Skill 列表中解析并校验浏览器提交的选择器。 */
export async function resolveClaudeSkill(emit: AgentEmit, cwd: string, selector: CodexSkillSelector, requireEnabled = false): Promise<CodexSkillMetadata> {
    if (!selector?.name || !selector.path || !path.isAbsolute(selector.path)) throw new CodexSkillLookupError("Skill 选择无效", 400);
    const { skills } = await listClaudeSkills(emit, cwd, true);
    const skill = skills.find((item) => item.name === selector.name && samePath(item.path, selector.path));
    if (!skill) throw new CodexSkillLookupError("找不到指定 Skill，请刷新列表后重试", 404);
    if (requireEnabled && !skill.enabled) throw new CodexSkillLookupError("该 Skill 已停用，请先启用后再使用", 409);
    return skill;
}

/** 修改 Claude Skill 的启用状态；停用的 Skill 不会进入 Claude 上下文。 */
export async function configureClaudeSkill(emit: AgentEmit, cwd: string, selector: CodexSkillSelector, enabled: boolean) {
    const skill = await resolveClaudeSkill(emit, cwd, selector);
    const disabled = new Set(await readDisabledSkills());
    if (enabled) disabled.delete(skill.path);
    else disabled.add(skill.path);
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(SKILL_STATE_FILE, JSON.stringify({ version: 1, disabled: [...disabled] }, null, 2));
    return { path: skill.path, effectiveEnabled: enabled, skill: { ...skill, enabled } };
}

/** 从当前对话或指定网页画布生成可编辑草稿，不写入 Skill 文件，也不保存临时会话。 */
export async function generateClaudeSkillDraft(_emit: AgentEmit, cwd: string, input: CodexSkillDraftInput) {
    const task = claudeQueue.catch(() => undefined).then(async () => {
        const options: Options = {
            cwd,
            persistSession: false,
            settingSources: [],
            tools: [],
            mcpServers: {},
            systemPrompt: SKILL_DRAFT_INSTRUCTIONS,
            outputFormat: { type: "json_schema", schema: SKILL_DRAFT_OUTPUT_SCHEMA },
            ...(input.model ? { model: input.model } : {}),
            ...claudeEffort(input.effort),
            ...(input.source === "conversation" ? { resume: input.threadId, forkSession: true } : {}),
        };
        let output: unknown;
        let failure = "";
        for await (const message of query({ prompt: skillDraftPrompt(input, AGENT_TITLE), options })) {
            if (message.type !== "result") continue;
            if (message.subtype === "success" && !message.is_error) output = message.structured_output;
            else failure = "errors" in message ? message.errors.join("\n") : message.result;
        }
        if (output === undefined) throw new Error(failure || "Claude 没有返回 Skill 草稿");
        return parseSkillDraft(output, input, AGENT_TITLE);
    });
    claudeQueue = task;
    return await task;
}

/** 判断会话异常是否允许自动新建会话后重试。 */
export function isRecoverableClaudeThreadError(error: unknown) {
    return /no rollout found|thread not loaded/i.test(errorMessage(error));
}

/** 执行一次 Claude turn，并把 SDK 消息转换为网页统一事件。 */
async function runClaudeTurnNow(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[], options: ClaudeRunOptions) {
    const cwd = options.cwd || process.cwd();
    const threadId = options.threadId && uuidPattern.test(options.threadId) ? options.threadId : crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const turn: ActiveTurn = { threadId, turnId, interrupted: false };
    const translator = new ClaudeTurnTranslator(threadId, turnId, cwd, lifecycleEmit);
    let finished = false;
    const finish = async (status: string, error?: string, usage?: unknown) => {
        if (finished) return;
        finished = true;
        await translator.complete(status, error && /not logged in|\/login/i.test(error) ? "Claude Code 尚未登录：请在终端运行 claude 并执行 /login，或配置 ANTHROPIC_API_KEY 后重试" : error, usage, prompt, options.messageText);
    };
    try {
        options.onStart?.();
        await ensureClaudeWorkspace(cwd);
        options.onThread?.(threadId);
        const exists = Boolean(await sessionInfo(threadId, cwd));
        options.onTurn?.(turnId);
        activeTurn = turn;
        translator.started();
        const skills = await enabledSkillNames(cwd);
        const permission = options.permissionMode || "request";
        const text = options.skill ? `/${options.skill.name} ${prompt}` : prompt;
        turn.query = query({
            prompt: singleMessage(userMessage(text, attachments)),
            options: {
                cwd,
                ...(exists ? { resume: threadId } : { sessionId: threadId }),
                ...(options.model ? { model: options.model } : {}),
                ...claudeEffort(options.effort),
                permissionMode: claudePermissionMode(permission),
                ...(permission === "full" ? { allowDangerouslySkipPermissions: true } : {}),
                canUseTool: approvalHandler(options.appEmit || lifecycleEmit, { threadId, turnId }, cwd),
                mcpServers: canvasMcpServers(),
                mcpServersDelivery: "initialize",
                systemPrompt: { type: "preset", preset: "claude_code", append: AGENT_PROMPT },
                settingSources: ["user", "project"],
                includePartialMessages: true,
                ...(skills ? { skills } : {}),
                stderr: (data) => logger.debug("Claude stderr", { text: data }),
            },
        });
        draftThreads.delete(threadId);
        for await (const message of turn.query) {
            if (message.type === "result") {
                const failed = message.subtype !== "success" || message.is_error;
                const error = failed ? ("errors" in message && message.errors.length ? message.errors.join("\n") : "result" in message ? message.result : "") : "";
                await finish(turn.interrupted ? "interrupted" : failed ? "failed" : "completed", turn.interrupted ? undefined : error || undefined, message.usage);
                continue;
            }
            translator.handle(message);
        }
        await finish(turn.interrupted ? "interrupted" : "completed");
    } catch (error) {
        logger.error("Claude turn failed", error);
        await finish(turn.interrupted ? "interrupted" : "failed", turn.interrupted ? undefined : errorMessage(error));
    } finally {
        [...approvals.entries()].filter(([, item]) => item.scope.turnId === turnId).forEach(([requestId]) => finishApproval(requestId, "cancel"));
        if (activeTurn === turn) activeTurn = null;
        options.onFinish?.();
    }
}

/** 将单次 turn 的 Claude SDK 消息转换为 Codex 兼容的 item / turn 事件并记录历史。 */
export class ClaudeTurnTranslator {
    private sequence = 0;
    private sequences = new Map<string, number>();
    private streamOrdinals = new Map<string, number>();
    private messageOrdinals = new Map<string, number>();
    private tools = new Map<string, JsonRecord>();
    private ignoredTools = new Set<string>();
    private plan: CodexPlanStep[] = [];
    private currentMessageId = "";

    constructor(private threadId: string, private turnId: string, private cwd: string, private emit: AgentEmit, private history: Pick<CodexEventHistory, "record" | "recordTurn"> = historyFor(threadId)) {}

    started() {
        this.event({ type: "turn.started" });
    }

    handle(message: SDKMessage) {
        if (message.type === "system" && message.subtype === "init") {
            const canvas = message.mcp_servers.find((item) => item.name === CANVAS_MCP);
            if (canvas?.status !== "connected") this.emit("agent_log", { text: `Infinite Canvas MCP 状态：${canvas?.status || "未加载"}`, threadId: this.threadId, turnId: this.turnId });
            return;
        }
        if (message.type === "system" && message.subtype === "compact_boundary") {
            this.itemEvent("item.completed", { id: message.uuid, type: "context_compaction", status: "completed" });
            return;
        }
        if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;
        if (message.type === "stream_event") return this.handleStream(message.event as unknown as JsonRecord);
        if (message.type === "assistant") return this.handleAssistant(message.message as unknown as JsonRecord);
        if (message.type === "user") return this.handleUser(field(message.message, "content"));
    }

    /** 记录 turn 终态后广播完成事件，确保历史快照成为权威内容。 */
    async complete(status: string, error: string | undefined, usage: unknown, prompt: string, messageText?: string) {
        this.tools.forEach((item) => this.itemEvent("item.completed", { ...item, status: status === "completed" ? "completed" : "failed" }));
        this.tools.clear();
        const normalizedUsage = usage ? { input_tokens: Number(field(usage, "input_tokens") || 0), cached_input_tokens: Number(field(usage, "cache_read_input_tokens") || 0), output_tokens: Number(field(usage, "output_tokens") || 0), reasoning_output_tokens: 0 } : null;
        if (normalizedUsage) this.event({ type: "usage.updated", usage: normalizedUsage });
        const turn = { id: this.turnId, status, ...(error ? { error: { message: error } } : {}), input: prompt, ...(messageText ? { messageText } : {}), ...(this.plan.length ? { plan: this.plan } : {}) };
        await this.history.recordTurn({ threadId: this.threadId, turnId: this.turnId, turn }).catch((historyError) => logger.warn("Failed to persist Claude turn history", { threadId: this.threadId, turnId: this.turnId, error: historyError }));
        this.event({ type: "turn.completed", status, error: error ? { message: error } : null, usage: normalizedUsage, turn });
        this.emit("agent_done", { agent: "claude", status, usage: normalizedUsage, thread_id: this.threadId, turn_id: this.turnId, threadId: this.threadId, turnId: this.turnId });
    }

    private handleStream(event: JsonRecord) {
        const type = String(event.type || "");
        if (type === "message_start") {
            this.currentMessageId = String(field(field(event, "message"), "id") || crypto.randomUUID());
            return;
        }
        const messageId = this.currentMessageId;
        if (!messageId) return;
        if (type === "content_block_start") {
            const ordinal = this.nextOrdinal(this.streamOrdinals, messageId);
            const blockType = String(field(field(event, "content_block"), "type") || "");
            const id = `${messageId}:${ordinal}`;
            if (blockType === "text") this.itemEvent("item.started", { id, type: "agent_message", text: "" });
            if (blockType === "thinking") this.itemEvent("item.started", { id, type: "reasoning", summary: "" });
            return;
        }
        if (type === "content_block_delta") {
            const delta = field(event, "delta");
            const ordinal = (this.streamOrdinals.get(messageId) || 1) - 1;
            const id = `${messageId}:${ordinal}`;
            if (field(delta, "type") === "text_delta") this.itemEvent("item.updated", { id, type: "agent_message", delta: String(field(delta, "text") || "") }, false);
            if (field(delta, "type") === "thinking_delta") this.itemEvent("item.updated", { id, type: "reasoning", delta: String(field(delta, "thinking") || "") }, false);
        }
    }

    private handleAssistant(message: JsonRecord) {
        const messageId = String(message.id || crypto.randomUUID());
        const content = Array.isArray(message.content) ? message.content as JsonRecord[] : [];
        content.forEach((block) => {
            const id = `${messageId}:${this.nextOrdinal(this.messageOrdinals, messageId)}`;
            if (block.type === "text" && String(block.text || "").trim()) this.itemEvent("item.completed", { id, type: "agent_message", text: String(block.text) });
            if (block.type === "thinking" && String(block.thinking || "").trim()) this.itemEvent("item.completed", { id, type: "reasoning", summary: String(block.thinking), status: "completed" });
            if (block.type === "tool_use") this.startTool(String(block.id || id), String(block.name || ""), (block.input || {}) as JsonRecord);
        });
    }

    private handleUser(content: unknown) {
        if (!Array.isArray(content)) return;
        content.forEach((block) => {
            if (field(block, "type") !== "tool_result") return;
            const toolUseId = String(field(block, "tool_use_id") || "");
            if (this.ignoredTools.delete(toolUseId)) return;
            const item = this.tools.get(toolUseId);
            if (!item) return;
            this.tools.delete(toolUseId);
            const failed = field(block, "is_error") === true;
            const text = toolResultText(field(block, "content"));
            this.itemEvent("item.completed", completeToolItem(item, text, failed));
        });
    }

    private startTool(id: string, name: string, input: JsonRecord) {
        if (name === "TodoWrite") {
            this.ignoredTools.add(id);
            const todos = Array.isArray(input.todos) ? input.todos as JsonRecord[] : [];
            this.plan = todos.map((todo) => ({ step: String(todo.content || ""), status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "inProgress" : "pending" }));
            this.event({ type: "plan.updated", explanation: null, plan: this.plan });
            return;
        }
        const item = toolItem(id, name, input, this.cwd);
        this.tools.set(id, item);
        this.itemEvent("item.started", item);
    }

    private itemEvent(type: string, item: JsonRecord, record = true) {
        const id = String(item.id);
        let sequence = this.sequences.get(id);
        if (sequence === undefined) {
            sequence = ++this.sequence;
            this.sequences.set(id, sequence);
        }
        this.event({ type, item });
        if (record && type === "item.completed") void this.history.record({ threadId: this.threadId, turnId: this.turnId, itemId: id, sequence, item }).catch((error) => logger.warn("Failed to persist Claude event history", { threadId: this.threadId, turnId: this.turnId, itemId: id, error }));
    }

    private event(payload: JsonRecord) {
        this.emit("agent_event", { agent: "claude", ...payload, thread_id: this.threadId, turn_id: this.turnId, threadId: this.threadId, turnId: this.turnId });
    }

    private nextOrdinal(map: Map<string, number>, messageId: string) {
        const ordinal = map.get(messageId) || 0;
        map.set(messageId, ordinal + 1);
        return ordinal;
    }
}

/** 将 Claude 工具调用映射为网页已支持的 item 类型。 */
function toolItem(id: string, name: string, input: JsonRecord, cwd: string): JsonRecord {
    if (name.startsWith("mcp__")) {
        const [, server = "", ...tool] = name.split("__");
        return { id, type: "mcp_tool_call", server, tool: tool.join("__"), arguments: input, status: "inProgress" };
    }
    if (name === "Bash") return { id, type: "command_execution", command: String(input.command || ""), cwd, status: "inProgress" };
    if (FILE_TOOLS.has(name)) return { id, type: "file_change", changes: [{ path: String(input.file_path || input.notebook_path || ""), kind: "update" }], status: "inProgress" };
    if (name === "WebSearch") return { id, type: "web_search", query: String(input.query || ""), action: { type: "search", query: String(input.query || "") }, status: "inProgress" };
    if (name === "WebFetch") return { id, type: "web_search", query: "", action: { type: "openPage", url: String(input.url || "") }, status: "inProgress" };
    return { id, type: "dynamic_tool_call", tool: name, arguments: input, status: "inProgress" };
}

function completeToolItem(item: JsonRecord, text: string, failed: boolean): JsonRecord {
    const status = failed ? "failed" : "completed";
    const error = failed ? { message: text || "工具调用失败" } : undefined;
    if (item.type === "mcp_tool_call") return { ...item, status, ...(error ? { error } : { result: { content: [{ type: "text", text }] } }) };
    if (item.type === "command_execution") return { ...item, status, aggregatedOutput: text, success: !failed };
    if (item.type === "dynamic_tool_call") return { ...item, status, success: !failed, contentItems: [{ type: "inputText", text }], ...(error ? { error } : {}) };
    return { ...item, status, ...(error ? { error } : {}) };
}

function toolResultText(content: unknown) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => field(block, "type") === "text" ? String(field(block, "text") || "") : field(block, "type") === "image" ? "[图片]" : "").filter(Boolean).join("\n");
}

/** 把网页审批决定转换为 Claude 工具权限结果。 */
function approvalHandler(emit: AgentEmit, scope: { threadId: string; turnId: string }, cwd: string): CanUseTool {
    return async (toolName, input, { signal, suggestions, toolUseID, title, description, blockedPath }) => {
        if (toolName.startsWith(`mcp__${CANVAS_MCP}__`)) return { behavior: "allow", updatedInput: input };
        const requestId = `claude-${crypto.randomUUID()}`;
        const reason = description || title || toolName;
        const params = toolName === "Bash"
            ? { method: "item/commandExecution/requestApproval", command: String(input.command || ""), cwd, reason }
            : FILE_TOOLS.has(toolName)
                ? { method: "item/fileChange/requestApproval", grantRoot: blockedPath || String(input.file_path || input.notebook_path || cwd), reason }
                : { method: "item/commandExecution/requestApproval", command: `${toolName} ${JSON.stringify(input).slice(0, 400)}`, cwd, reason };
        return await new Promise<PermissionResult>((resolve) => {
            approvals.set(requestId, { resolve, suggestions, input, emit, scope });
            signal.addEventListener("abort", () => finishApproval(requestId, "cancel"), { once: true });
            emit("codex_approval", { requestId, ...params, itemId: toolUseID, threadId: scope.threadId, turnId: scope.turnId });
        });
    };
}

function finishApproval(requestId: string, decision: string) {
    const approval = approvals.get(requestId);
    if (!approval || approval.decision) return;
    approval.decision = decision;
    approvals.delete(requestId);
    const accepted = decision === "accept" || decision === "acceptForSession";
    approval.resolve(accepted
        ? { behavior: "allow", updatedInput: approval.input, ...(decision === "acceptForSession" && approval.suggestions?.length ? { updatedPermissions: approval.suggestions.map((item) => ({ ...item, destination: "session" as const })) } : {}) }
        : { behavior: "deny", message: "用户拒绝了本次操作", ...(decision === "cancel" ? { interrupt: true } : {}) });
    approval.emit("codex_approval_resolved", { requestId, decision, threadId: approval.scope.threadId, turnId: approval.scope.turnId });
}

function claudePermissionMode(mode: AgentPermissionMode): PermissionMode {
    if (mode === "full") return "bypassPermissions";
    if (mode === "automatic") return "auto";
    return "default";
}

function claudeEffort(effort?: CodexReasoningEffort): { effort?: EffortLevel } {
    if (!effort) return {};
    if (effort === "minimal") return { effort: "low" };
    if (effort === "ultra") return { effort: "max" };
    return { effort };
}

function userMessage(text: string, attachments: AgentAttachment[]): SDKUserMessage {
    const images = attachments.flatMap((item) => {
        const [, mediaType = "", data = ""] = item.dataUrl?.match(/^data:(image\/[^;]+);base64,(.+)$/) || [];
        return data ? [{ type: "image" as const, source: { type: "base64" as const, media_type: mediaType as "image/png", data } }] : [];
    });
    return { type: "user", message: { role: "user", content: [{ type: "text", text }, ...images] }, parent_tool_use_id: null };
}

async function* singleMessage(message: SDKUserMessage) {
    yield message;
}

/** 通过一次不发送消息的会话读取账号可用模型。 */
async function loadClaudeModels() {
    let release = () => {};
    const idle = new Promise<void>((resolve) => (release = resolve));
    const probe = query({ prompt: (async function* () { await idle; })(), options: { cwd: os.tmpdir(), persistSession: false, settingSources: [] } });
    try {
        const models = await probe.supportedModels();
        const data = models.map((model) => {
            const efforts = model.supportsEffort === false ? [] : model.supportedEffortLevels || [];
            return {
                id: model.value,
                model: model.value,
                displayName: model.displayName,
                description: model.description,
                defaultReasoningEffort: efforts.includes("high") ? "high" : efforts.at(-1) || "medium",
                supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
                isDefault: model.value === "default",
            };
        });
        return { data };
    } finally {
        release();
        probe.close();
    }
}

/** 让 Claude 通过项目级 `.claude/skills` 发现站点工作空间中的画布 Skill。 */
async function ensureClaudeWorkspace(cwd: string) {
    const skillsDir = path.join(cwd, ".agents", "skills");
    const linkPath = path.join(cwd, ".claude", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    const existing = await fs.lstat(linkPath).catch(() => null);
    if (existing) return;
    await fs.symlink(process.platform === "win32" ? skillsDir : path.join("..", ".agents", "skills"), linkPath, process.platform === "win32" ? "junction" : "dir");
}

/** Claude 只加载技能页列出且已启用的 Skill，与界面展示保持一致。 */
async function enabledSkillNames(cwd: string) {
    const { skills } = await listClaudeSkills(() => undefined, cwd);
    return skills.filter((skill) => skill.enabled).map((skill) => skill.name);
}

async function readDisabledSkills(): Promise<string[]> {
    try {
        const value = JSON.parse(await fs.readFile(SKILL_STATE_FILE, "utf8")) as { disabled?: unknown };
        return Array.isArray(value.disabled) ? value.disabled.map(String) : [];
    } catch {
        return [];
    }
}

function canvasMcpServers(): Options["mcpServers"] {
    return { [CANVAS_MCP]: { type: "stdio", command: canvasAgentMcp.command, args: canvasAgentMcp.args } };
}

/** 真实启动一次画布 MCP 并读取状态，作为对话准备阶段的就绪依据。 */
async function preheatMcp(emit: AgentEmit, threadId: string, cwd: string) {
    const startup = (status: string, error?: string) => emit("agent_bootstrap", { type: "mcp.startup", phase: "preheat", threadId, name: CANVAS_MCP, status, error: error || null });
    startup("starting");
    let release = () => {};
    const idle = new Promise<void>((resolve) => (release = resolve));
    const probe = query({ prompt: (async function* () { await idle; })(), options: { cwd: cwd || os.tmpdir(), persistSession: false, settingSources: [], mcpServers: canvasMcpServers(), mcpServersDelivery: "initialize" } });
    try {
        const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
        let server = (await probe.mcpServerStatus()).find((item) => item.name === CANVAS_MCP);
        while ((!server || server.status === "pending") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            server = (await probe.mcpServerStatus()).find((item) => item.name === CANVAS_MCP);
        }
        if (server?.status === "connected") startup("ready");
        else startup("failed", server?.error || (server ? `MCP 状态：${server.status}` : "MCP 未加载"));
    } catch (error) {
        startup("failed", errorMessage(error));
    } finally {
        release();
        probe.close();
        emit("agent_bootstrap", { type: "mcp.complete", phase: "preheat", threadId, services: [{ name: CANVAS_MCP }] });
    }
}

async function sessionInfo(threadId: string, cwd: string) {
    if (!uuidPattern.test(threadId)) return undefined;
    return await getSessionInfo(threadId, cwd ? { dir: cwd } : undefined).catch(() => undefined);
}

function summarizeSession(info: SDKSessionInfo, cwd: string) {
    const updatedAt = Math.floor(info.lastModified / 1000);
    const createdAt = Number(field(info, "createdAt") || 0);
    return summarizeCodexThread({
        id: info.sessionId,
        preview: info.firstPrompt || info.summary || "",
        name: info.customTitle || null,
        cwd: info.cwd || cwd,
        status: "notLoaded",
        createdAt: createdAt ? Math.floor(createdAt / 1000) : updatedAt,
        updatedAt,
    });
}

function assertThreadId(threadId: string) {
    if (!uuidPattern.test(threadId)) throw new Error("Claude 会话 ID 无效");
}

function historyFile(threadId: string) {
    assertThreadId(threadId);
    return path.join(HISTORY_DIR, `${threadId}.json`);
}

function historyFor(threadId: string) {
    let history = histories.get(threadId);
    if (!history) {
        history = new CodexEventHistory(historyFile(threadId));
        histories.set(threadId, history);
    }
    return history;
}

async function mergeMessageMetadata<T extends { role: string; threadId: string; turnId: string }>(threadId: string, messages: T[]) {
    try {
        return await messageMetadataStore.mergeThread(threadId, messages);
    } catch (error) {
        logger.warn("Failed to read thread message metadata", { threadId, error });
        return messages;
    }
}
