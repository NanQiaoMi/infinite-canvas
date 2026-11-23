import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanvasToolRequest } from "./operations.js";

function opsOf(name: Parameters<typeof buildCanvasToolRequest>[0], input: Record<string, unknown>) {
    const request = buildCanvasToolRequest(name, input, null);
    return (request.input as { ops: Array<Record<string, any>> }).ops;
}

test("generation flow reuses referenced nodes when the prompt only mentions them", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "@[node:text-1]", referenceNodeIds: ["text-1"], title: "Flow", autoRun: true });
    const addedTextNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(addedTextNodes.length, 0);
    assert.equal(ops.filter((op) => op.type === "connect_nodes" && op.fromNodeId === "text-1" && String(op.toNodeId).startsWith("config-")).length, 1);
    assert.match(String(config?.metadata?.prompt), /^@\[node:text-1\]$/);
    assert.equal(runs.length, 1);
});

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", referenceNodeIds: ["text-1"], autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.match(String(config?.metadata?.prompt), /@\[node:text-/);
});

test("video generation flow auto-switches to reference mode above 2 references and rejects >10", () => {
    const ops = opsOf("canvas_generate_video", { prompt: "combine [图1] and [图3]", referenceNodeIds: ["img-1", "img-2", "img-3"] });
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.equal(config?.metadata?.videoMode, "reference");
    assert.throws(
        () => opsOf("canvas_generate_video", { prompt: "too many", referenceNodeIds: Array.from({ length: 11 }, (_, i) => `img-${i + 1}`) }),
        /最多支持 10 个/,
    );
});

test("storyboard flow batches shots vertically, deduplicates shared references, and runs only shot 1 when autoRunFirst is true", () => {
    const ops = opsOf("canvas_create_storyboard_flow", {
        x: 100,
        y: 50,
        rowGap: 300,
        seconds: "6",
        sharedReferenceNodeIds: ["char-1", "scene-1"],
        autoRunFirst: true,
        shots: [
            { title: "开场", prompt: "主角走进咖啡馆", referenceNodeIds: ["char-1", "prop-1"] },
            { title: "特写", prompt: "主角微笑看镜头", seconds: "4" },
        ],
    });
    const textNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const configNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(textNodes.length, 2);
    assert.equal(configNodes.length, 2);
    assert.deepEqual(textNodes[0].position, { x: 100, y: 50 });
    assert.deepEqual(textNodes[1].position, { x: 100, y: 350 });
    assert.deepEqual(configNodes[0].position, { x: 520, y: 50 });
    assert.equal(configNodes[0].metadata?.videoMode, "reference");
    assert.equal(configNodes[1].metadata?.seconds, "4");
    assert.equal(
        ops.filter((op) => op.type === "connect_nodes" && op.toNodeId === configNodes[0].id).length,
        4,
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].nodeId, configNodes[0].id);
});

test("storyboard flow rejects any shot exceeding 10 merged reference nodes", () => {
    assert.throws(
        () =>
            opsOf("canvas_create_storyboard_flow", {
                sharedReferenceNodeIds: ["s1", "s2", "s3"],
                shots: [
                    { prompt: "shot 1 ok", referenceNodeIds: ["r1"] },
                    { prompt: "shot 2 too many", referenceNodeIds: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"] },
                ],
            }),
        /第 2 镜参考节点超过 10 个/,
    );
});
