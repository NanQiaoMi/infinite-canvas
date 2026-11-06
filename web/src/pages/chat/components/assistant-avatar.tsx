import { cn } from "@/lib/utils";

/**
 * 助手品牌头像：
 * 采用应用官方几何棱镜 Logo（/logo.svg），搭配素雅中性灰阶，
 * 彻底告别泛滥陈旧的黄色 AI 星星符号，质感对齐 OpenAI / Claude 极简高级感。
 */
export function AssistantAvatar({ className }: { className?: string }) {
    return (
        <div
            className={cn(
                "mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-stone-100/90 shadow-xs transition-colors dark:border-stone-800 dark:bg-stone-850",
                className,
            )}
        >
            <span
                className="size-4 shrink-0 bg-stone-700 dark:bg-stone-300"
                style={{
                    mask: "url(/logo.svg) center / contain no-repeat",
                    WebkitMask: "url(/logo.svg) center / contain no-repeat",
                }}
            />
        </div>
    );
}
