import { Search } from "lucide-react";
import { type UIEvent, useEffect, useState } from "react";
import { App, Empty, Input, Modal, Spin, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const { query, items, tags: promptTags, categories: promptCategories } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, enabled: open });
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = (prompt: string) => {
        onSelect(prompt);
        onOpenChange(false);
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    const categoryChips = promptCategories.map((category) => (
        <Tag.CheckableTag
            key={category}
            checked={selectedCategory === category}
            className={cn("prompt-filter-tag shrink-0 whitespace-nowrap", selectedCategory === category && "is-active")}
            onChange={() => setSelectedCategory(category)}
        >
            {category === ALL_PROMPTS_OPTION ? t("common.all") : category}
        </Tag.CheckableTag>
    ));

    const tagChips = promptTags.map((tag) => {
        const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
        return (
            <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag shrink-0 whitespace-nowrap", active && "is-active")} onChange={() => toggleTag(tag)}>
                {tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}
            </Tag.CheckableTag>
        );
    });

    return (
        <Modal
            title={t("prompts.library")}
            open={open}
            onCancel={() => onOpenChange(false)}
            footer={null}
            width="min(1120px, calc(100vw - 24px))"
            centered
            styles={{ body: { padding: 0 } }}
            className="prompt-select-dialog"
        >
            <div
                className="flex h-[min(72dvh,640px)] min-h-0 flex-col gap-3 px-3 pb-3 pt-1 sm:h-[min(68dvh,640px)] sm:flex-row sm:gap-5 sm:px-5 sm:pb-5 sm:pt-2"
                data-canvas-no-zoom
                onWheelCapture={(event) => event.stopPropagation()}
            >
                {/* 桌面端：左侧分类/标签导航 */}
                <aside className="thin-scrollbar hidden min-h-0 w-[190px] shrink-0 overflow-y-auto border-r border-stone-200 pr-4 dark:border-stone-800 sm:block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.category")}</div>
                    <div className="flex flex-wrap gap-1.5">{categoryChips}</div>
                    <div className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.tags")}</div>
                    <div className="flex flex-wrap gap-1.5">{tagChips}</div>
                </aside>

                {/* 竖屏/小屏：分类与标签改为横向滚动筛选条，避免挤压内容 */}
                <div className="flex min-w-0 flex-col gap-2 sm:hidden">
                    <div className="thin-scrollbar flex items-center gap-1.5 overflow-x-auto pb-0.5">
                        {categoryChips}
                    </div>
                    <div className="thin-scrollbar flex items-center gap-1.5 overflow-x-auto pb-0.5">
                        {tagChips}
                    </div>
                </div>

                <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <Input size="large" allowClear prefix={<Search className="size-4 shrink-0 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("prompts.searchTitle")} />
                    <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto pr-1 sm:mt-4 sm:pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                        {query.isLoading ? (
                            <div className="flex h-40 items-center justify-center">
                                <Spin />
                            </div>
                        ) : null}
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
                            {items.map((item: Prompt) => (
                                <PromptCard key={item.id} item={item} onOpen={() => selectPrompt(item.prompt)} onCopy={() => selectPrompt(item.prompt)} compact />
                            ))}
                        </div>
                        {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.empty")} className="py-8" /> : null}
                        {query.isFetchingNextPage ? (
                            <div className="py-4 text-center">
                                <Spin size="small" />
                            </div>
                        ) : null}
                    </div>
                </section>
            </div>
        </Modal>
    );
}
