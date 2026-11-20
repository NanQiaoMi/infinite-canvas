import type { AgentRuntimeName } from "../config.js";
import { archiveClaudeThread, configureClaudeSkill, generateClaudeSkillDraft, interruptClaudeTurn, isRecoverableClaudeThreadError, listClaudeModels, listClaudeSkills, listClaudeThreads, readClaudeThread, resolveClaudeApproval, resolveClaudeSkill, resumeClaudeThread, runClaudeTurn, startClaudeThread } from "./claude.js";
import { archiveCodexThread, configureCodexSkill, generateCodexSkillDraft, interruptCodexTurn, isRecoverableThreadError, listCodexModels, listCodexSkills, listCodexThreads, readCodexThread, resolveCodexApproval, resolveCodexSkill, resumeCodexThread, runCodexTurn, startCodexThread } from "./codex.js";

/** 网页 Agent 面板可切换的本地运行时；两者对外暴露相同的会话、历史、Skill 与审批能力。 */
export const agentRuntimes = {
    codex: {
        title: "Codex",
        startThread: startCodexThread,
        resumeThread: resumeCodexThread,
        readThread: readCodexThread,
        listThreads: listCodexThreads,
        archiveThread: archiveCodexThread,
        listModels: listCodexModels,
        listSkills: listCodexSkills,
        resolveSkill: resolveCodexSkill,
        configureSkill: configureCodexSkill,
        generateSkillDraft: generateCodexSkillDraft,
        runTurn: runCodexTurn,
        interrupt: interruptCodexTurn,
        resolveApproval: resolveCodexApproval,
        isRecoverableThreadError,
    },
    claude: {
        title: "Claude",
        startThread: startClaudeThread,
        resumeThread: resumeClaudeThread,
        readThread: readClaudeThread,
        listThreads: listClaudeThreads,
        archiveThread: archiveClaudeThread,
        listModels: listClaudeModels,
        listSkills: listClaudeSkills,
        resolveSkill: resolveClaudeSkill,
        configureSkill: configureClaudeSkill,
        generateSkillDraft: generateClaudeSkillDraft,
        runTurn: runClaudeTurn,
        interrupt: interruptClaudeTurn,
        resolveApproval: resolveClaudeApproval,
        isRecoverableThreadError: isRecoverableClaudeThreadError,
    },
} satisfies Record<AgentRuntimeName, unknown>;

export function isAgentRuntime(value: unknown): value is AgentRuntimeName {
    return value === "codex" || value === "claude";
}
