import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type ServerConfig } from "../src/config";
import { findClientById } from "../src/identity";
import type { Capability, CapabilityLimits, ClientRecord, QuotaPolicy } from "../src/types";
import { CAPABILITIES } from "../src/types";
import { defaultQuotaPolicy } from "../src/config";

export const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../src/schema.sql"), "utf8");

export function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    return db;
}

export function createTestConfig(overrides: Record<string, string> = {}): { config: ServerConfig; cleanup: () => void } {
    const dataDir = mkdtempSync(join(tmpdir(), "ic-server-test-"));
    const config = loadConfig({
        DATA_DIR: dataDir,
        ADMIN_PASSWORD: "test-password-123",
        PORT: "0",
        ...overrides,
    });
    return {
        config,
        cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
    };
}

export function insertClient(db: Database, id = "client-1", fingerprint = "fp-abc-123456"): ClientRecord {
    const now = Date.now();
    db.query(
        "INSERT INTO clients (id, fingerprint, fingerprint_source, user_agent, first_ip, last_ip, first_seen_at, last_seen_at, blocked, note) VALUES (?, ?, 'builtin', 'bun-test', '127.0.0.1', '127.0.0.1', ?, ?, 0, '')",
    ).run(id, fingerprint, now, now);
    const client = findClientById(db, id);
    if (!client) throw new Error("failed to create test client");
    return client;
}

export function testPolicy(overrides: Partial<Record<Capability, Partial<CapabilityLimits>>> = {}): QuotaPolicy {
    const policy = defaultQuotaPolicy({});
    for (const capability of CAPABILITIES) {
        const override = overrides[capability];
        if (override) policy.capabilities[capability] = { ...policy.capabilities[capability], ...override };
    }
    return policy;
}
