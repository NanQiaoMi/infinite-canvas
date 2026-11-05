import { App, Button, Drawer, Dropdown, Input, Popconfirm, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { RefreshCw, Search, ShieldOff, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverApi } from "@/services/api/server";
import type { AdminClientDetail, AdminClientItem, AdminClientsResponse, ServerCapability } from "@/types/server";

import { ADMIN_CAPABILITIES, capabilityLabelKey, formatAdminTime } from "../format";

const PAGE_SIZE = 20;

export function ClientsPanel() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [data, setData] = useState<AdminClientsResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [detail, setDetail] = useState<AdminClientDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const load = useCallback(
        async (nextPage: number, nextQuery: string) => {
            setLoading(true);
            try {
                const response = await serverApi.admin.clients({ q: nextQuery, page: nextPage, pageSize: PAGE_SIZE });
                setData(response);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
            } finally {
                setLoading(false);
            }
        },
        [message, t],
    );

    useEffect(() => {
        void load(page, query);
    }, [page, query, load]);

    const refresh = () => void load(page, query);

    const openDetail = async (client: AdminClientItem) => {
        setDetailLoading(true);
        setDetail(null);
        try {
            setDetail(await serverApi.admin.client(client.id));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        } finally {
            setDetailLoading(false);
        }
    };

    const resetQuota = async (client: AdminClientItem, scope: "daily" | "weekly" | "all") => {
        try {
            await serverApi.admin.resetClientQuota(client.id, scope);
            message.success(t("server.admin.clients.resetDone"));
            refresh();
            if (detail?.client.id === client.id) openDetail(client);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        }
    };

    const toggleBlock = async (client: AdminClientItem, blocked: boolean) => {
        try {
            await serverApi.admin.blockClient(client.id, blocked);
            message.success(t("server.admin.clients.blockDone"));
            refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.common.failed"));
        }
    };

    const usageCell = (item: AdminClientItem, window: "today" | "week") => {
        const usage = item.usage[window];
        return ADMIN_CAPABILITIES.filter((capability) => usage[capability] > 0)
            .map((capability) => `${t(capabilityLabelKey(capability))} ${usage[capability]}`)
            .join(" · ");
    };

    const columns: TableColumnsType<AdminClientItem> = [
        {
            title: t("server.admin.clients.fingerprint"),
            dataIndex: "fingerprint",
            width: 170,
            render: (value: string) => <span className="font-mono text-xs" title={value}>{value.slice(0, 16)}</span>,
        },
        {
            title: "IP",
            key: "ip",
            width: 150,
            render: (_value, item) => (
                <div className="text-xs">
                    <div>{item.lastIp || "-"}</div>
                    <div className="text-stone-400">{t("server.admin.clients.ipCount", { count: item.ipCount })}</div>
                </div>
            ),
        },
        { title: t("server.admin.clients.todayUsage"), key: "today", render: (_value, item) => <span className="text-xs">{usageCell(item, "today") || "-"}</span> },
        { title: t("server.admin.clients.weekUsage"), key: "week", render: (_value, item) => <span className="text-xs">{usageCell(item, "week") || "-"}</span> },
        { title: t("server.admin.clients.lastSeen"), dataIndex: "lastSeenAt", width: 150, render: (value: number) => <span className="text-xs">{formatAdminTime(value, i18n.resolvedLanguage || "zh-CN")}</span> },
        {
            title: t("server.admin.clients.status"),
            dataIndex: "blocked",
            width: 90,
            render: (value: boolean) => (value ? <Tag color="red">{t("server.admin.clients.blocked")}</Tag> : <Tag>{t("server.admin.clients.normal")}</Tag>),
        },
        {
            title: t("server.admin.common.actions"),
            key: "actions",
            width: 230,
            render: (_value, item) => (
                <Space size={4}>
                    <Button size="small" icon={<UserRound className="size-3.5" />} onClick={() => void openDetail(item)}>
                        {t("server.admin.clients.detail")}
                    </Button>
                    <Dropdown
                        menu={{
                            items: [
                                { key: "daily", label: t("server.admin.clients.resetDaily") },
                                { key: "weekly", label: t("server.admin.clients.resetWeekly") },
                                { key: "all", label: t("server.admin.clients.resetAll") },
                            ],
                            onClick: ({ key }) => void resetQuota(item, key as "daily" | "weekly" | "all"),
                        }}
                    >
                        <Button size="small">{t("server.admin.clients.reset")}</Button>
                    </Dropdown>
                    <Popconfirm title={t(item.blocked ? "server.admin.clients.unblockConfirm" : "server.admin.clients.blockConfirm")} onConfirm={() => void toggleBlock(item, !item.blocked)}>
                        <Button size="small" danger={!item.blocked} icon={<ShieldOff className="size-3.5" />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    const detailQuotaRows = ADMIN_CAPABILITIES.map((capability) => ({
        key: capability,
        capability,
        daily: `${detail?.quota.capabilities[capability].dailyUsed ?? 0}/${detail?.quota.capabilities[capability].dailyLimit ?? 0}`,
        weekly: `${detail?.quota.capabilities[capability].weeklyUsed ?? 0}/${detail?.quota.capabilities[capability].weeklyLimit ?? 0}`,
    }));

    const ipColumns: TableColumnsType<NonNullable<AdminClientDetail>["ips"][number]> = [
        { title: "IP", dataIndex: "ip" },
        { title: t("server.admin.clients.firstSeen"), dataIndex: "first_seen_at", render: (value: number) => formatAdminTime(value, i18n.resolvedLanguage || "zh-CN") },
        { title: t("server.admin.clients.lastSeen"), dataIndex: "last_seen_at", render: (value: number) => formatAdminTime(value, i18n.resolvedLanguage || "zh-CN") },
        { title: t("server.admin.clients.hits"), dataIndex: "hits", align: "right" },
    ];

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t("server.admin.clients.description")}</div>
                <div className="flex items-center gap-2">
                    <Input
                        allowClear
                        size="small"
                        className="w-64"
                        prefix={<Search className="size-3.5 text-stone-400" />}
                        placeholder={t("server.admin.clients.searchPlaceholder")}
                        value={keyword}
                        onChange={(event) => setKeyword(event.target.value)}
                        onPressEnter={() => {
                            setPage(1);
                            setQuery(keyword.trim());
                        }}
                    />
                    <Button
                        size="small"
                        onClick={() => {
                            setPage(1);
                            setQuery(keyword.trim());
                        }}
                    >
                        {t("server.admin.clients.search")}
                    </Button>
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={refresh}>
                        {t("server.admin.common.refresh")}
                    </Button>
                </div>
            </div>
            <Table<AdminClientItem>
                size="small"
                rowKey="id"
                loading={loading}
                columns={columns}
                dataSource={data?.items || []}
                pagination={{
                    current: page,
                    pageSize: PAGE_SIZE,
                    total: data?.total || 0,
                    showSizeChanger: false,
                    onChange: (nextPage) => setPage(nextPage),
                }}
            />
            <Drawer
                open={Boolean(detail) || detailLoading}
                width={760}
                title={t("server.admin.clients.detailTitle")}
                onClose={() => setDetail(null)}
            >
                {detail ? (
                    <div className="space-y-4">
                        <div className="grid gap-2 rounded-lg border border-stone-200 p-3 text-xs dark:border-stone-800 md:grid-cols-2">
                            <div>
                                <span className="text-stone-500">{t("server.admin.clients.fingerprint")}: </span>
                                <span className="font-mono">{detail.client.fingerprint}</span>
                            </div>
                            <div>
                                <span className="text-stone-500">UA: </span>
                                <span>{detail.client.userAgent || "-"}</span>
                            </div>
                            <div>
                                <span className="text-stone-500">{t("server.admin.clients.firstSeen")}: </span>
                                <span>{formatAdminTime(detail.client.firstSeenAt, i18n.resolvedLanguage || "zh-CN")}</span>
                            </div>
                            <div>
                                <span className="text-stone-500">{t("server.admin.clients.lastSeen")}: </span>
                                <span>{formatAdminTime(detail.client.lastSeenAt, i18n.resolvedLanguage || "zh-CN")}</span>
                            </div>
                        </div>
                        <div>
                            <div className="mb-2 text-sm font-semibold">{t("server.admin.clients.quota")}</div>
                            <Table size="small" rowKey="key" pagination={false} dataSource={detailQuotaRows} columns={[
                                { title: t("server.admin.usage.capability"), dataIndex: "capability", render: (value: ServerCapability) => t(capabilityLabelKey(value)) },
                                { title: t("server.admin.clients.dailyUsage"), dataIndex: "daily", align: "right" },
                                { title: t("server.admin.clients.weeklyUsage"), dataIndex: "weekly", align: "right" },
                            ]} />
                        </div>
                        <div>
                            <div className="mb-2 text-sm font-semibold">{t("server.admin.clients.ipHistory")}</div>
                            <Table size="small" rowKey="ip" pagination={{ pageSize: 5, hideOnSinglePage: true }} dataSource={detail.ips} columns={ipColumns} />
                        </div>
                        <div>
                            <div className="mb-2 text-sm font-semibold">{t("server.admin.clients.events")}</div>
                            <Table
                                size="small"
                                rowKey="id"
                                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                                dataSource={detail.events}
                                columns={[
                                    { title: t("server.admin.usage.time"), dataIndex: "created_at", render: (value: number) => formatAdminTime(value, i18n.resolvedLanguage || "zh-CN") },
                                    { title: t("server.admin.usage.capability"), dataIndex: "capability", render: (value: ServerCapability) => t(capabilityLabelKey(value)) },
                                    { title: t("server.admin.usage.model"), dataIndex: "model", ellipsis: true },
                                    { title: t("server.admin.usage.units"), dataIndex: "units", align: "right", width: 70 },
                                    { title: t("server.admin.usage.status"), dataIndex: "state", width: 100, render: (value: string) => <Tag>{value}</Tag> },
                                ]}
                            />
                        </div>
                    </div>
                ) : null}
            </Drawer>
        </div>
    );
}
