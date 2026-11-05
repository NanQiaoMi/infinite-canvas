import { App, Button, Spin, Tabs } from "antd";
import { ArrowLeft, BarChart3, LayoutDashboard, LogOut, Settings, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { serverApi } from "@/services/api/server";
import { useConfigStore } from "@/stores/use-config-store";
import type { AdminSessionInfo } from "@/types/server";

import { ChannelsPanel } from "./components/channels-panel";
import { ClientsPanel } from "./components/clients-panel";
import { OverviewPanel } from "./components/overview-panel";
import { QuotaPolicyPanel } from "./components/quota-policy-panel";
import { SettingsPanel } from "./components/settings-panel";
import { UsagePanel } from "./components/usage-panel";
import { AdminLoginPanel } from "./components/login-panel";

const TAB_KEYS = ["overview", "channels", "quota", "usage", "clients", "settings"] as const;
type TabKey = (typeof TAB_KEYS)[number];

export default function AdminPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [session, setSession] = useState<AdminSessionInfo | null>(null);
    const [checking, setChecking] = useState(true);
    const [tab, setTab] = useState<TabKey>("overview");

    useEffect(() => {
        let cancelled = false;
        serverApi.admin
            .session()
            .then((info) => {
                if (cancelled) return;
                setSession(info);
                useConfigStore.setState({ isAdmin: true });
            })
            .catch(() => {
                if (!cancelled) setSession(null);
            })
            .finally(() => {
                if (!cancelled) setChecking(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const logout = async () => {
        try {
            await serverApi.admin.logout();
        } catch {
            // 忽略退出失败，前端仍回到登录态。
        }
        useConfigStore.setState({ isAdmin: false });
        setSession(null);
        message.success(t("server.admin.loggedOut"));
    };

    if (checking) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <Spin size="large" />
            </div>
        );
    }

    if (!session) {
        return (
            <AdminLoginPanel
                onLoggedIn={(info) => {
                    setSession(info);
                    useConfigStore.setState({ isAdmin: true });
                }}
            />
        );
    }

    const tabLabel = (key: TabKey, icon: ReactNode) => (
        <span className="inline-flex items-center gap-1.5">
            {icon}
            {t(`server.admin.tabs.${key}`)}
        </span>
    );

    return (
        <div className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-background/95 px-6 py-3 backdrop-blur dark:border-stone-800">
                <div className="flex items-center gap-3">
                    <Link to="/" className="inline-flex size-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-900 dark:hover:bg-white/10 dark:hover:text-white" title={t("server.admin.backToApp")}>
                        <ArrowLeft className="size-4" />
                    </Link>
                    <ShieldCheck className="size-5" />
                    <div>
                        <div className="text-sm font-semibold">{t("server.admin.title")}</div>
                        <div className="text-xs text-stone-500">{t("server.admin.subtitle")}</div>
                    </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-stone-500">
                    <span className="hidden sm:inline">{session.username}</span>
                    <Button size="small" icon={<LogOut className="size-3.5" />} onClick={() => void logout()}>
                        {t("server.admin.logout")}
                    </Button>
                </div>
            </header>
            <main className="mx-auto max-w-[1240px] px-6 py-6">
                <Tabs
                    activeKey={tab}
                    onChange={(key) => setTab(key as TabKey)}
                    items={[
                        { key: "overview", label: tabLabel("overview", <LayoutDashboard className="size-4" />), children: <OverviewPanel onNavigate={(key) => setTab(key as TabKey)} /> },
                        { key: "channels", label: tabLabel("channels", <SlidersHorizontal className="size-4" />), children: <ChannelsPanel /> },
                        { key: "quota", label: tabLabel("quota", <ShieldCheck className="size-4" />), children: <QuotaPolicyPanel /> },
                        { key: "usage", label: tabLabel("usage", <BarChart3 className="size-4" />), children: <UsagePanel /> },
                        { key: "clients", label: tabLabel("clients", <Users className="size-4" />), children: <ClientsPanel /> },
                        { key: "settings", label: tabLabel("settings", <Settings className="size-4" />), children: <SettingsPanel /> },
                    ]}
                />
            </main>
        </div>
    );
}
