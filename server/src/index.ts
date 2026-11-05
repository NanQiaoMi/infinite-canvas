import { existsSync } from "node:fs";

import { ensureAdminAccount, runRetentionCleanup } from "./admin";
import { loadSystemSettings } from "./admin-settings";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openStore } from "./db";
import { log } from "./logger";

const config = loadConfig();
const store = openStore(config.dbPath, config.schemaPath);
const db = store.db;

const bootstrap = await ensureAdminAccount(db, config);
if (bootstrap.generatedPassword) {
    log.warn("已生成管理员初始密码，请登录 /admin 后立即修改（该密码只打印一次）", { username: bootstrap.username, password: bootstrap.generatedPassword });
} else {
    log.info("管理员账号已就绪", { username: bootstrap.username });
}

if (!existsSync(config.webDistDir)) {
    log.warn("未找到前端产物，静态页面将不可用（先执行 cd web && bun run build）", { webDistDir: config.webDistDir });
}

const app = createApp(config, db);

const server = Bun.serve({
    port: config.port,
    maxRequestBodySize: config.maxBodyBytes + 1024 * 1024,
    fetch(req, bunServer) {
        return app.fetch(req, bunServer.requestIP(req)?.address ?? "unknown");
    },
});

log.info("server listening", {
    port: server.port,
    version: config.version,
    dataDir: config.dataDir,
    webDistDir: config.webDistDir,
});

const retentionTimer = setInterval(() => {
    runRetentionCleanup(db, loadSystemSettings(db).retentionDays);
}, 6 * 60 * 60 * 1000);
retentionTimer.unref?.();
runRetentionCleanup(db, loadSystemSettings(db).retentionDays);

const shutdown = (signal: string) => {
    log.info("server shutting down", { signal });
    server.stop(true);
    db.close();
    process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
