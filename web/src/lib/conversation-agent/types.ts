export type AgentRole = "user" | "assistant" | "tool" | "error";

export type AgentToolErrorCode = "invalid_args" | "quota_exceeded" | "unsupported" | "execution_failed" | "canceled";

export type AgentImageRef = {
    id: string;
    storageKey?: string;
    width: number;
    height: number;
    prompt: string;
    model: string;
};

export type AgentQuotaSnapshot = {
    dailyUsed: number;
    dailyLimit: number;
    weeklyUsed: number;
    weeklyLimit: number;
};

export type AgentToolResult =
    | { tool: "generate_image"; ok: true; images: AgentImageRef[]; model: string; size: string; count: number; quota?: AgentQuotaSnapshot }
    | { tool: "edit_image"; ok: true; images: AgentImageRef[]; model: string; size: string; count: number; quota?: AgentQuotaSnapshot }
    | { tool: "apply_prompt"; ok: true; target: "image" | "video"; prompt: string }
    | { tool: string; ok: false; code: AgentToolErrorCode; error: string };

export type AgentToolCall = { tool: string; arguments: Record<string, unknown> };

export type AgentMessage =
    | { id: string; role: "user"; text: string; attachments?: AgentImageRef[]; createdAt: number }
    | { id: string; role: "assistant"; text: string; raw?: string; promptBlocks: string[]; createdAt: number }
    | { id: string; role: "tool"; call: AgentToolCall; result: AgentToolResult; text: string; createdAt: number }
    | { id: string; role: "error"; text: string; createdAt: number };

export type AgentSession = {
    id: string;
    title: string;
    messages: AgentMessage[];
    createdAt: number;
    updatedAt: number;
};

/** 运行上下文：每次模型调用前由页面构建，保证注入的是最新额度/模型信息。 */
export type AgentContextInput = {
    imageModels: string[];
    defaultImageModel: string;
    defaultSize: string;
    defaultQuality: string;
    defaultCount: string;
    quota?: AgentQuotaSnapshot;
    pageContext?: string;
    toolChannel: "native" | "text";
};

export type AgentToolDefinition = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
};

/** 喂给模型的扁平消息；工具结果会转成 user 消息内容。 */
export type AgentModelMessage = { role: "user" | "assistant"; content: string };

export type AgentModelTurnResult = {
    content: string;
    toolCalls: AgentToolCall[];
    toolCallErrors?: Array<{ tool: string; error: string }>;
};

export type AgentModelCall = (request: {
    systemPrompt: string;
    messages: AgentModelMessage[];
    tools: AgentToolDefinition[];
    signal: AbortSignal;
    onDelta: (text: string) => void;
}) => Promise<AgentModelTurnResult>;

export type AgentToolExecutor = (call: AgentToolCall, context: { signal: AbortSignal; references?: AgentImageRef[] }) => Promise<AgentToolResult>;

export type AgentEvent =
    | { type: "assistant-stream"; text: string }
    | { type: "tool-start"; call: AgentToolCall }
    | { type: "tool-end"; call: AgentToolCall; result: AgentToolResult };

export type AgentLaunchContext = {
    page: "image" | "video";
    prompt?: string;
    model?: string;
    size?: string;
    quality?: string;
    count?: string;
};

export type AgentTurnResult = {
    messages: AgentMessage[];
    aborted: boolean;
    roundLimitReached: boolean;
};
