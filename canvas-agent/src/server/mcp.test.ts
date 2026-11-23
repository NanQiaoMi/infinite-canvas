import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMcpToolResult } from "./mcp.js";

test("formatMcpToolResult wraps plain tool outputs as a single JSON text block", () => {
    const out = formatMcpToolResult({ ok: true, count: 2 });
    assert.deepEqual(out, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, count: 2 }, null, 2) }],
    });
});

test("formatMcpToolResult strips _mcpImages from JSON and appends labeled MCP image blocks", () => {
    const out = formatMcpToolResult({
        ok: true,
        summary: "6 frames",
        _mcpImages: [
            { mimeType: "image/jpeg", data: "QUJD", label: "参考图拼图" },
            { mimeType: "", data: "REVG" },
            { mimeType: "image/png", data: "" },
        ],
    });

    assert.equal(out.content.length, 4);
    assert.deepEqual(out.content[0], {
        type: "text",
        text: JSON.stringify({ ok: true, summary: "6 frames" }, null, 2),
    });
    assert.deepEqual(out.content[1], { type: "text", text: "参考图拼图" });
    assert.deepEqual(out.content[2], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
    assert.deepEqual(out.content[3], { type: "image", data: "REVG", mimeType: "image/jpeg" });
});
