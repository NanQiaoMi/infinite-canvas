import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { nowMs } from "./clock";
import { log } from "./logger";

export type Store = {
    db: Database;
};

export function openStore(dbPath: string, schemaPath: string): Store {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(readFileSync(schemaPath, "utf8"));
    migrate(db);
    setSetting(db, "schema_version", "2");
    log.info("database ready", { path: dbPath });
    return { db };
}

/** 轻量迁移：仅追加对旧库缺失的列，不改动已有数据。 */
function migrate(db: Database) {
    const columns = db.query("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "tool_protocol")) {
        db.exec("ALTER TABLE channels ADD COLUMN tool_protocol TEXT NOT NULL DEFAULT 'auto'");
    }
}

export function getSetting(db: Database, key: string): string | null {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string) {
    db.query("INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, nowMs());
}

export function getJsonSetting<T>(db: Database, key: string): T | null {
    const raw = getSetting(db, key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        log.warn("invalid json setting", { key });
        return null;
    }
}

export function setJsonSetting(db: Database, key: string, value: unknown) {
    setSetting(db, key, JSON.stringify(value));
}

export function deleteSetting(db: Database, key: string) {
    db.query("DELETE FROM settings WHERE key = ?").run(key);
}

/** 在单个 SQLite 事务中执行；用于额度预占等需要原子性的操作。 */
export function transaction<T>(db: Database, run: () => T): T {
    return db.transaction(run)();
}
