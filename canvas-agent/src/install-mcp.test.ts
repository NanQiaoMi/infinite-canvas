import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { antigravityConfigFile, codexPluginEnabled, launchSpec, localEntry, parseInstallArgs, resolveLocalEntry, writeAntigravityConfig } from "./install-mcp.js";

function makeTempHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "install-mcp-test-"));
}

const entry = path.join(os.tmpdir(), "canvas-agent", "dist", "index.js");

test("writeAntigravityConfig creates the file with the exact server object", () => {
    const home = makeTempHome();
    try {
        const spec = launchSpec(entry);
        const file = writeAntigravityConfig(home, spec);
        assert.equal(file, antigravityConfigFile(home));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
            mcpServers: { "infinite-canvas": { command: process.execPath, args: [entry, "mcp"], env: {} } },
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("writeAntigravityConfig preserves other servers and backs up once", () => {
    const home = makeTempHome();
    const file = antigravityConfigFile(home);
    const original = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other-bin" } } }, null, 2) + "\n";
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, original);
        writeAntigravityConfig(home, launchSpec(entry));
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(config.theme, "dark");
        assert.deepEqual(config.mcpServers.other, { command: "other-bin" });
        assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), original);

        fs.writeFileSync(file, "{}");
        writeAntigravityConfig(home, launchSpec(entry));
        assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), original);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("writeAntigravityConfig rejects invalid JSON and leaves the file unchanged", () => {
    const home = makeTempHome();
    const file = antigravityConfigFile(home);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{bad");
        assert.throws(() => writeAntigravityConfig(home, launchSpec(entry)), /不是有效 JSON/);
        assert.equal(fs.readFileSync(file, "utf8"), "{bad");
        assert.equal(fs.existsSync(`${file}.bak`), false);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("writeAntigravityConfig treats an existing empty or whitespace-only file as {}", () => {
    const home = makeTempHome();
    const file = antigravityConfigFile(home);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "");
        writeAntigravityConfig(home, launchSpec(entry));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
            mcpServers: { "infinite-canvas": { command: process.execPath, args: [entry, "mcp"], env: {} } },
        });
        assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), "");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("codexPluginEnabled detects an enabled infinite-canvas plugin section", () => {
    const home = makeTempHome();
    const file = path.join(home, ".codex", "config.toml");
    try {
        assert.equal(codexPluginEnabled(home), false, "missing file");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '[plugins."infinite-canvas@infinite-canvas-local"]\nenabled = true\n');
        assert.equal(codexPluginEnabled(home), true);
        fs.writeFileSync(file, '[plugins."infinite-canvas@infinite-canvas-local"]\nenabled = false\n');
        assert.equal(codexPluginEnabled(home), false, "disabled");
        fs.writeFileSync(file, '[model]\nenabled = true\n[plugins."other@x"]\nenabled = true\n');
        assert.equal(codexPluginEnabled(home), false, "absent section");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("launchSpec uses the current node binary with entry and mcp", () => {
    assert.deepEqual(launchSpec(entry), { command: process.execPath, args: [entry, "mcp"] });
});

test("parseInstallArgs defaults to all clients and parses flags", () => {
    assert.deepEqual(parseInstallArgs([]), { client: "all", dryRun: false });
    assert.deepEqual(parseInstallArgs(["--local"]), { client: "all", dryRun: false, local: true });
    assert.deepEqual(parseInstallArgs(["--client", "codex", "--entry", "/x", "--dry-run", "--local"]), { client: "codex", entry: "/x", dryRun: true, local: true });
    assert.throws(() => parseInstallArgs(["--client", "vscode"]), /不支持的客户端：vscode/);
});

test("localEntry resolves dist/index.js relative to module URL and resolveLocalEntry validates existence", () => {
    const base = makeTempHome();
    try {
        const fakeSrcDir = path.join(base, "canvas-agent", "src");
        fs.mkdirSync(fakeSrcDir, { recursive: true });
        const fakeMetaUrl = new URL(`file://${fakeSrcDir}/install-mcp.ts`).href;
        const expected = path.join(base, "canvas-agent", "dist", "index.js");

        assert.equal(localEntry(fakeMetaUrl), expected);
        assert.throws(() => resolveLocalEntry(fakeMetaUrl), /本地构建产物不存在.*npm run build/);

        fs.mkdirSync(path.dirname(expected), { recursive: true });
        fs.writeFileSync(expected, "// built");
        assert.equal(resolveLocalEntry(fakeMetaUrl), expected);

        const builtMetaUrl = new URL(`file://${base}/canvas-agent/dist/install-mcp.js`).href;
        assert.equal(resolveLocalEntry(builtMetaUrl), expected);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
