import { Button, Card, Col, Row, Statistic, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverApi } from "@/services/api/server";
import type { AdminOverview, ServerCapability } from "@/types/server";

import { ADMIN_CAPABILITIES, capabilityLabelKey, formatUptime } from "../format";

type UsageRow = { capability: ServerCapability; today: number; week: number };

export function OverviewPanel({ onNavigate }: { onNavigate: (key: string) => void }) {
    const { t } = useTranslation();
    const [data, setData] = useState<AdminOverview | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setData(await serverApi.admin.overview());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const toMap = (list: AdminOverview["usage"]["today"]) => {
        const map = new Map<ServerCapability, number>();
        for (const item of list) map.set(item.capability, item.units);
        return map;
    };
    const todayMap = toMap(data?.usage.today || []);
    const weekMap = toMap(data?.usage.week || []);
    const rows: UsageRow[] = ADMIN_CAPABILITIES.map((capability) => ({ capability, today: todayMap.get(capability) || 0, week: weekMap.get(capability) || 0 }));

    const columns: TableColumnsType<UsageRow> = [
        { title: t("server.admin.usage.capability"), dataIndex: "capability", render: (value: ServerCapability) => <Tag>{t(capabilityLabelKey(value))}</Tag> },
        { title: t("server.admin.usage.today"), dataIndex: "today", align: "right" },
        { title: t("server.admin.usage.week"), dataIndex: "week", align: "right" },
    ];

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t("server.admin.overview.description")}</div>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                    {t("server.admin.common.refresh")}
                </Button>
            </div>
            <Row gutter={[12, 12]}>
                <Col xs={12} md={6}>
                    <Card size="small">
                        <Statistic title={t("server.admin.overview.channels")} value={data?.channels.enabled ?? "-"} suffix={data ? `/ ${data.channels.total}` : undefined} />
                    </Card>
                </Col>
                <Col xs={12} md={6}>
                    <Card size="small">
                        <Statistic title={t("server.admin.overview.clients")} value={data?.clients.total ?? "-"} />
                    </Card>
                </Col>
                <Col xs={12} md={6}>
                    <Card size="small">
                        <Statistic title={t("server.admin.overview.activeToday")} value={data?.clients.activeToday ?? "-"} />
                    </Card>
                </Col>
                <Col xs={12} md={6}>
                    <Card size="small">
                        <Statistic title={t("server.admin.overview.version")} value={data?.version ?? "-"} />
                        <div className="mt-1 text-[11px] text-stone-500">
                            {t("server.admin.overview.uptime")}: {data ? formatUptime(data.uptimeSeconds) : "-"}
                        </div>
                    </Card>
                </Col>
            </Row>
            <Card size="small" title={t("server.admin.overview.usageTitle")}>
                <Table<UsageRow> size="small" rowKey="capability" pagination={false} columns={columns} dataSource={rows} loading={loading && !data} />
            </Card>
            <div className="flex flex-wrap gap-2">
                <Button size="small" onClick={() => onNavigate("channels")}>
                    {t("server.admin.tabs.channels")}
                </Button>
                <Button size="small" onClick={() => onNavigate("quota")}>
                    {t("server.admin.tabs.quota")}
                </Button>
                <Button size="small" onClick={() => onNavigate("clients")}>
                    {t("server.admin.tabs.clients")}
                </Button>
            </div>
        </div>
    );
}
