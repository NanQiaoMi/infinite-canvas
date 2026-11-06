import { CheckCircle2, Circle, LoaderCircle, ListChecks, RefreshCw, Timer, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export type AgentStepStatus = "running" | "done" | "error" | "correction" | "waiting-retry";
export type AgentStep = {
    id: string;
    kind: "understand" | "respond" | "summarize" | "tool" | "correction" | "retry";
    label: string;
    status: AgentStepStatus;
    detail?: string;
};

export function StepTrail({ steps, running }: { steps: AgentStep[]; running: boolean }) {
    const { t } = useTranslation();
    if (!steps.length) return null;
    const done = steps.filter((step) => step.status === "done").length;
    return (
        <div className="agent-fade-in flex gap-3">
            <div className="w-7 shrink-0" />
            <div className="min-w-0 flex-1">
                <div className={cn("rounded-xl border border-stone-200/80 bg-white/50 px-3 py-2 dark:border-stone-800 dark:bg-white/[.03]", !running && "agent-fade-out")}>
                    <div className="flex items-center gap-2 text-[11px] font-medium text-stone-500 dark:text-stone-400">
                        <ListChecks className="size-3.5" />
                        {t("chat.steps.title")}
                        <span className="ml-auto tabular-nums text-stone-400 dark:text-stone-500">
                            {done}/{steps.length}
                        </span>
                    </div>
                    <ol className="mt-1.5 space-y-1">
                        {steps.map((step) => (
                            <li key={step.id} className="flex items-center gap-2 text-xs">
                                {step.status === "done" ? (
                                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                ) : step.status === "error" ? (
                                    <XCircle className="size-3.5 shrink-0 text-red-500" />
                                ) : step.status === "correction" ? (
                                    <RefreshCw className="size-3.5 shrink-0 animate-spin text-amber-500 dark:text-amber-400" />
                                ) : step.status === "waiting-retry" ? (
                                    <Timer className="size-3.5 shrink-0 animate-pulse text-orange-500 dark:text-orange-400" />
                                ) : step.status === "running" ? (
                                    <LoaderCircle className="size-3.5 shrink-0 animate-spin text-stone-400" />
                                ) : (
                                    <Circle className="size-3.5 shrink-0 text-stone-300 dark:text-stone-600" />
                                )}
                                <span className={cn("min-w-0 flex-1 truncate", step.status === "done" ? "text-stone-500 dark:text-stone-400" : "text-stone-700 dark:text-stone-200")}>{step.label}</span>
                                {step.status === "running" ? (
                                    <span className="shrink-0 text-[10px] text-stone-400 dark:text-stone-500">{t("chat.steps.running")}</span>
                                ) : step.status === "correction" ? (
                                    <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                                        {t("chat.steps.correctionRetry")}
                                    </span>
                                ) : step.status === "waiting-retry" ? (
                                    <span className="shrink-0 rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-600 dark:bg-orange-400/15 dark:text-orange-400">
                                        {t("chat.steps.waitingRetry")}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </div>
    );
}
