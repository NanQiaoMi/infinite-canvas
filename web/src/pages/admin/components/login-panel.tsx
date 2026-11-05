import { App, Button, Form, Input } from "antd";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { serverApi } from "@/services/api/server";
import type { AdminSessionInfo } from "@/types/server";

export function AdminLoginPanel({ onLoggedIn }: { onLoggedIn: (session: AdminSessionInfo) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [form] = Form.useForm<{ username: string; password: string }>();
    const [loading, setLoading] = useState(false);

    const submit = async () => {
        const values = await form.validateFields();
        setLoading(true);
        try {
            await serverApi.admin.login(values.username.trim(), values.password);
            const session = await serverApi.admin.session();
            onLoggedIn(session);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("server.admin.login.failed"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
            <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-background p-6 shadow-sm dark:border-stone-800">
                <div className="mb-5 flex items-center gap-3">
                    <ShieldCheck className="size-6" />
                    <div>
                        <div className="text-base font-semibold">{t("server.admin.login.title")}</div>
                        <div className="text-xs text-stone-500">{t("server.admin.subtitle")}</div>
                    </div>
                </div>
                <Form form={form} layout="vertical" requiredMark={false} onFinish={() => void submit()}>
                    <Form.Item name="username" label={t("server.admin.login.username")} rules={[{ required: true, message: t("server.admin.login.username") }]}>
                        <Input autoComplete="username" autoFocus />
                    </Form.Item>
                    <Form.Item name="password" label={t("server.admin.login.password")} rules={[{ required: true, message: t("server.admin.login.password") }]}>
                        <Input.Password autoComplete="current-password" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={loading}>
                        {t("server.admin.login.submit")}
                    </Button>
                </Form>
                <div className="mt-4 text-center text-xs">
                    <Link to="/" className="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">
                        {t("server.admin.backToApp")}
                    </Link>
                </div>
            </div>
        </div>
    );
}
