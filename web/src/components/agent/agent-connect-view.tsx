import type { ClipboardEvent } from "react";
import { App, Button, Input, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { ChevronRight, Copy, KeyRound, Link2, PlugZap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { connectionColor } from "./agent-panel-utils";
import { useThemeStore } from "@/stores/use-theme-store";

const AGENT_START_COMMAND = "npx -y @basketikun/canvas-agent@latest";
const AGENT_INSTALL_MCP_COMMAND = "npx -y @basketikun/canvas-agent@latest install-mcp";
const AGENT_PLUGIN_REMOVE_COMMAND = "codex plugin remove infinite-canvas";
const AGENT_MCP_REMOVE_COMMAND = "codex mcp remove infinite-canvas";

export function parseAgentConnectText(text: string): { url?: string; token?: string } {
    return { url: text.match(/Local URL:\s*(\S+)/i)?.[1], token: text.match(/Connect token:\s*([A-Za-z0-9]+)/i)?.[1] };
}

function CommandRow({ command, label }: { command: string; label?: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const { message } = App.useApp();
    const copyCommand = () => {
        copyToClipboard(command);
        message.success(t("agent.connect.commandCopied"));
    };
    return (
        <div className="flex items-center gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            {label ? (
                <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                    {label}
                </span>
            ) : null}
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] leading-5">{command}</code>
            <Tooltip title={t("agent.connect.copyCommand")}>
                <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={copyCommand} />
            </Tooltip>
        </div>
    );
}

export function AgentConnectView({
    url,
    token,
    enabled,
    connected,
    activity,
    connectError,
    onUrlChange,
    onTokenChange,
    onToggleEnabled,
}: {
    url: string;
    token: string;
    enabled: boolean;
    connected: boolean;
    activity: string;
    connectError: string;
    onUrlChange: (value: string) => void;
    onTokenChange: (value: string) => void;
    onToggleEnabled: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const { message } = App.useApp();
    const steps = [{ title: t("agent.connect.pluginTitle"), text: t("agent.connect.pluginText") }, { title: t("agent.connect.directTitle"), text: t("agent.connect.directText"), command: AGENT_START_COMMAND }, { title: t("agent.connect.installMcpTitle"), text: t("agent.connect.installMcpText"), command: AGENT_INSTALL_MCP_COMMAND }];
    const statusText = connectError ? t("agent.status.failed") : connected ? activity : enabled ? t("agent.status.connecting") : t("agent.status.disconnected");
    const statusColor = connectionColor({ connectError, connected, enabled }, theme);
    const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
        const pasted = parseAgentConnectText(event.clipboardData.getData("text"));
        if (!pasted.url && !pasted.token) return;
        event.preventDefault();
        if (pasted.url) onUrlChange(pasted.url);
        if (pasted.token) onTokenChange(pasted.token);
        message.success(t("agent.connect.pasteFilled"));
    };
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">{t("agent.connect.title")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        {t("agent.connect.description")}
                    </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 text-sm font-medium leading-5">{t("agent.connect.webConnection")}</span>
                                <span
                                    className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4"
                                    style={{ borderColor: connected || enabled || connectError ? statusColor : theme.node.stroke, color: statusColor }}
                                >
                                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: statusColor }} />
                                    <span className="truncate">{statusText}</span>
                                </span>
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                {t("agent.connect.autoDiscover")}
                            </div>
                        </div>
                        <Button className="!h-8 !px-3" type={enabled ? "default" : "primary"} icon={<PlugZap className="size-4" />} onClick={onToggleEnabled}>
                            {t(enabled ? "agent.connect.disconnect" : "agent.connect.connect")}
                        </Button>
                    </div>
                    <div className="mt-3 grid gap-2.5">
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <Link2 className="size-3.5" />
                                {t("agent.connect.localAddress")}
                                <span className="font-normal opacity-70">{t("agent.connect.localAddressHint")}</span>
                            </span>
                            <Input
                                size="large"
                                prefix={<Link2 className="mr-1 size-4" style={{ color: theme.node.faint }} />}
                                value={url}
                                onChange={(event) => onUrlChange(event.target.value)}
                                onPaste={handlePaste}
                                placeholder={t("agent.connect.urlPlaceholder")}
                            />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <KeyRound className="size-3.5" />
                                {t("agent.connect.token")}
                                <span className="font-normal opacity-70">{t("agent.connect.tokenHint")}</span>
                            </span>
                            <Input.Password
                                size="large"
                                prefix={<KeyRound className="mr-1 size-4" style={{ color: theme.node.faint }} />}
                                value={token}
                                onChange={(event) => onTokenChange(event.target.value)}
                                onPaste={handlePaste}
                                placeholder={t("agent.connect.tokenPlaceholder")}
                            />
                        </label>
                        {connectError ? (
                            <div className="grid gap-2">
                                <div className="rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: `color-mix(in srgb, ${theme.status.danger} 35%, transparent)`, color: theme.status.danger }}>
                                    {connectError}
                                </div>
                                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                                    {t("agent.connect.agentNotRunning")}
                                </div>
                                <CommandRow command={AGENT_START_COMMAND} />
                            </div>
                        ) : null}
                    </div>
                </div>
                <details className="group">
                    <summary className="cursor-pointer list-none select-none rounded-md px-2 py-1.5 text-xs leading-5 hover:bg-black/5 dark:hover:bg-white/10 [&::-webkit-details-marker]:hidden" style={{ color: theme.node.muted }}>
                        <div className="flex items-center gap-1.5">
                            <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
                            {t("agent.connect.moreOptions")}
                        </div>
                    </summary>
                    <div className="mt-2 space-y-2">
                        {steps.map((step, index) => (
                            <div key={step.title} className="rounded-lg px-3 py-2.5">
                                <div className="text-sm font-medium leading-5">{step.title}</div>
                                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                    {step.text}
                                </div>
                                {step.command ? <div className="mt-2"><CommandRow command={step.command} /></div> : null}
                                {index === 0 ? (
                                    <div className="mt-2 rounded-lg border px-3 py-2.5 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                        <div className="font-medium" style={{ color: theme.node.text }}>
                                            {t("agent.connect.pluginReminder")}
                                        </div>
                                        <div className="mt-1">{t("agent.connect.pluginReminderText")}</div>
                                        <div className="mt-2 grid gap-1.5">
                                            <CommandRow label={t("agent.connect.removePlugin")} command={AGENT_PLUGIN_REMOVE_COMMAND} />
                                            <CommandRow label={t("agent.connect.removeMcp")} command={AGENT_MCP_REMOVE_COMMAND} />
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </details>
            </div>
        </div>
    );
}
