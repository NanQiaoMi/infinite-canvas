PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_cipher TEXT NOT NULL DEFAULT '',
    api_format TEXT NOT NULL DEFAULT 'openai',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_models (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    capability TEXT NOT NULL,
    script TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, name)
);

CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    fingerprint_source TEXT NOT NULL DEFAULT 'builtin',
    user_agent TEXT NOT NULL DEFAULT '',
    first_ip TEXT NOT NULL DEFAULT '',
    last_ip TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_fingerprint ON clients(fingerprint);

CREATE TABLE IF NOT EXISTS client_ips (
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (client_id, ip)
);

CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT '',
    capability TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    units INTEGER NOT NULL,
    state TEXT NOT NULL,
    upstream_status INTEGER,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_client_time ON usage_events(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_ip_time ON usage_events(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_state ON usage_events(state);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    capability TEXT NOT NULL DEFAULT '',
    window TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_resets_lookup ON quota_resets(window, created_at);
