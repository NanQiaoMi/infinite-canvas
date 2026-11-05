import { Button, Card, Segmented, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverApi } from "@/services/api/server";
import type { AdminUsageEvent, AdminUsageResponse, ServerCapability } from "@/types/server";

import { ADMIN_CAPABILITIES, capabilityLabelKey, formatAdminTime } from "../format";

type CapabilityRow = { capability: ServerCapability; units: number; requests: number };

export function UsagePanel() {
    const { t, i18n } = useTranslation();
    const [days, setDays] = useState(7);
    const [data, setData] = useState<AdminUsageResponse | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        async (range: number) => {
            setLoading(true);
            try {
                setData(await serverApi.admin.usage(range));
            } catch {
                setData(null);
            } finally {
                setLoading(false);
            }
        },
        [],
    );

    useEffect(() => {
        void load(days);
    }, [days, load]);

    const totals = new Map<ServerCapability, { units: number; requests: number }>();
    for (const item of data?.totals || []) totals.set(item.capability, { units: item.units, requests: item.requests });
    const rows: CapabilityRow[] = ADMIN_CAPABILITIES.map((capability) => ({ capability, units: totals.get(capability)?.units ?? 0, requests: totals.get(capability)?.requests ?? 0 }));

    const capabilityColumns: TableColumnsType<CapabilityRow> = [
        { title: t("server.admin.usage.capability"), dataIndex: "capability", render: (value: ServerCapability) => <Tag>{t(capabilityLabelKey(value))}</Tag> },
        { title: t("server.admin.usage.units"), dataIndex: "units", align: "right" },
        { title: t("server.admin.usage.requests"), dataIndex: "requests", align: "right" },
    ];

    const eventColumns: TableColumnsType<AdminUsageEvent> = [
        { title: t("server.admin.usage.time"), dataIndex: "created_at", width: 170, render: (value: number) => formatAdminTime(value, i18n.resolvedLanguage || "zh-CN") },
        { title: t("server.admin.usage.capability"), dataIndex: "capability", width: 80, render: (value: ServerCapability) => t(capabilityLabelKey(value)) },
        { title: t("server.admin.usage.model"), dataIndex: "model", ellipsis: true },
        { title: t("server.admin.usage.units"), dataIndex: "units", width: 70, align: "right" },
        { title: t("server.admin.usage.client"), dataIndex: "client_id", width: 150, ellipsis: true, render: (value: string) => <span className="font-mono text-xs">{value.slice(0, 8)}</span> },
        { title: "IP", dataIndex: "ip", width: 130, ellipsis: true },
        { title: t("server.admin.usage.status"), dataIndex: "state", width: 100, render: (value: string) => <Tag>{value}</Tag> },
    ];

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t("server.admin.usage.description")}</div>
                <div className="flex items-center gap-2">
                    <Segmented
                        size="small"
                        value={days}
                        options={[
                            { value: 7, label: t("server.admin.usage.days", { days: 7 }) },
                            { value: 30, label: t("server.admin.usage.days", { days: 30 }) },
                        ]}
                        onChange={(value) => setDays(Number(value))}
                    />
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load(days)}>
                        {t("server.admin.common.refresh")}
                    </Button>
                </div>
            </div>
            <Card size="small">
                <Table<CapabilityRow> size="small" rowKey="capability" pagination={false} columns={capabilityColumns} dataSource={rows} loading={loading && !data} />
            </Card>
            <Card size="small" title={t("server.admin.usage.recent")}>
                <Table<AdminUsageEvent> size="small" rowKey="id" pagination={{ pageSize: 10, hideOnSinglePage: true }} columns={eventColumns} dataSource={data?.recent || []} loading={loading && !data} />
            </Card>
        </div>
    );
}
