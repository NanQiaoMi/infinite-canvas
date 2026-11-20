import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeTurnTranslator } from "./claude.js";

const threadId = "11111111-1111-4111-8111-111111111111";

function createTurn() {
    const events: Array<{ type: string; payload: any }> = [];
    const records: any[] = [];
    const turns: any[] = [];
    const emit = (type: string, payload: unknown) => {
        events.push({ type, payload });
    };
    const history = {
        record: async (entry: unknown) => {
            records.push(entry);
        },
        recordTurn: async (entry: unknown) => {
            turns.push(entry);
            events.push({ type: "record_turn", payload: entry });
        },
    };
    const translator = new ClaudeTurnTranslator(threadId, "turn-1", "/tmp/ws", emit as never, history as never);
    return { events, records, turns, translator, agentEvents: () => agentEvents(events) };
}

type Turn = ReturnType<typeof createTurn>;

function send(turn: Turn, message: unknown) {
    turn.translator.handle(message as never);
}

function agentEvents(events: Array<{ type: string; payload: any }>) {
    return events.filter((event) => event.type === "agent_event").map((event) => event.payload);
}

function ofType(events: any[], type: string) {
    return events.filter((event) => event.type === type);
}

function assistant(id: string, content: unknown[], parentToolUseId: string | null = null) {
    return { type: "assistant", message: { id, content }, parent_tool_use_id: parentToolUseId };
}

function toolResult(toolUseId: string, content: unknown, isError = false) {
    return { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } };
}

test("streams text deltas and completes the agent message", () => {
    const turn = createTurn();
    turn.translator.started();
    send(turn, { type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } });
    send(turn, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } });
    send(turn, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } });
    send(turn, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } });
    send(turn, assistant("msg_1", [{ type: "text", text: "Hello" }]));

    const events = turn.agentEvents();
    assert.equal(events[0].type, "turn.started");

    const started = ofType(events, "item.started");
    assert.equal(started.length, 1);
    assert.equal(started[0].item.id, "msg_1:0");
    assert.equal(started[0].item.type, "agent_message");

    const updates = ofType(events, "item.updated");
    assert.deepEqual(updates.map((event) => event.item.delta), ["Hel", "lo"]);
    assert.ok(updates.every((event) => event.item.id === "msg_1:0"));

    const completed = ofType(events, "item.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].item.id, "msg_1:0");
    assert.equal(completed[0].item.text, "Hello");

    assert.ok(events.every((event) => event.agent === "claude" && event.thread_id === threadId && event.turn_id === "turn-1"));

    assert.equal(turn.records.length, 1);
    assert.equal(turn.records[0].itemId, "msg_1:0");
    assert.equal(turn.records[0].sequence, 1);
});

test("keeps thinking and text items ordered within one message id", () => {
    const streamed = createTurn();
    streamed.translator.started();
    send(streamed, { type: "stream_event", event: { type: "message_start", message: { id: "msg_2" } } });
    send(streamed, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } });
    send(streamed, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } } });
    send(streamed, { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } });
    send(streamed, assistant("msg_2", [{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }]));

    const completed = ofType(streamed.agentEvents(), "item.completed");
    const reasoning = completed.find((event) => event.item.type === "reasoning");
    const message = completed.find((event) => event.item.type === "agent_message");
    assert.equal(reasoning?.item.id, "msg_2:0");
    assert.equal(reasoning?.item.summary, "plan");
    assert.equal(message?.item.id, "msg_2:1");
    assert.equal(message?.item.text, "done");

    const split = createTurn();
    send(split, assistant("msg_2", [{ type: "thinking", thinking: "plan" }]));
    send(split, assistant("msg_2", [{ type: "text", text: "done" }]));
    const splitCompleted = ofType(split.agentEvents(), "item.completed");
    assert.deepEqual(splitCompleted.map((event) => [event.item.id, event.item.type]), [["msg_2:0", "reasoning"], ["msg_2:1", "agent_message"]]);
    assert.equal(splitCompleted[0].item.summary, "plan");
    assert.equal(splitCompleted[1].item.text, "done");
});

test("maps MCP tool calls to mcp_tool_call items", () => {
    const turn = createTurn();
    send(turn, assistant("msg_3", [{ type: "tool_use", id: "toolu_1", name: "mcp__infinite-canvas__canvas_get_state", input: {} }]));
    send(turn, toolResult("toolu_1", [{ type: "text", text: "{\"nodes\":[]}" }]));

    const events = turn.agentEvents();
    const started = ofType(events, "item.started");
    assert.equal(started.length, 1);
    assert.equal(started[0].item.type, "mcp_tool_call");
    assert.equal(started[0].item.server, "infinite-canvas");
    assert.equal(started[0].item.tool, "canvas_get_state");
    assert.equal(started[0].item.status, "inProgress");

    const completed = ofType(events, "item.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].item.id, "toolu_1");
    assert.equal(completed[0].item.status, "completed");
    assert.equal(completed[0].item.result.content[0].text, "{\"nodes\":[]}");
});

test("marks failed Bash tool results as failed command executions", () => {
    const turn = createTurn();
    send(turn, assistant("msg_4", [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } }]));
    send(turn, toolResult("toolu_2", "boom", true));

    const completed = ofType(turn.agentEvents(), "item.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].item.type, "command_execution");
    assert.equal(completed[0].item.status, "failed");
    assert.equal(completed[0].item.success, false);
    assert.equal(completed[0].item.aggregatedOutput, "boom");
    assert.equal(completed[0].item.command, "ls");
    assert.equal(completed[0].item.cwd, "/tmp/ws");
});

test("maps file edit, web fetch and unknown tools to matching items", () => {
    const turn = createTurn();
    send(turn, assistant("msg_5", [
        { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: "/a.txt" } },
        { type: "tool_use", id: "toolu_web", name: "WebFetch", input: { url: "https://x" } },
        { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/a.txt" } },
    ]));
    send(turn, toolResult("toolu_read", "file body"));

    const events = turn.agentEvents();
    const started = ofType(events, "item.started");
    const byId = (id: string) => started.find((event) => event.item.id === id).item;

    const edit = byId("toolu_edit");
    assert.equal(edit.type, "file_change");
    assert.equal(edit.changes[0].path, "/a.txt");

    const web = byId("toolu_web");
    assert.equal(web.type, "web_search");
    assert.equal(web.action.type, "openPage");
    assert.equal(web.action.url, "https://x");

    const read = byId("toolu_read");
    assert.equal(read.type, "dynamic_tool_call");
    assert.equal(read.tool, "Read");

    const completed = ofType(events, "item.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].item.id, "toolu_read");
    assert.equal(completed[0].item.status, "completed");
    assert.equal(completed[0].item.success, true);
    assert.equal(completed[0].item.contentItems[0].text, "file body");
});

test("turns TodoWrite into plan updates without tool items", async () => {
    const turn = createTurn();
    turn.translator.started();
    send(turn, assistant("msg_6", [{
        type: "tool_use",
        id: "toolu_todo",
        name: "TodoWrite",
        input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] },
    }]));
    send(turn, toolResult("toolu_todo", "ok"));

    const plan = [{ step: "a", status: "completed" }, { step: "b", status: "inProgress" }, { step: "c", status: "pending" }];
    const events = turn.agentEvents();
    const planEvents = ofType(events, "plan.updated");
    assert.equal(planEvents.length, 1);
    assert.deepEqual(planEvents[0].plan, plan);
    assert.equal(ofType(events, "item.started").length, 0);
    assert.equal(ofType(events, "item.completed").length, 0);

    await turn.translator.complete("completed", undefined, null, "prompt text");
    assert.equal(turn.turns.length, 1);
    assert.deepEqual(turn.turns[0].turn.plan, plan);
});

test("ignores messages from subagents", () => {
    const turn = createTurn();
    send(turn, assistant("msg_7", [{ type: "text", text: "inner" }], "toolu_parent"));
    assert.deepEqual(turn.events, []);
});

test("completes unfinished tools and records the turn before turn.completed", async () => {
    const turn = createTurn();
    turn.translator.started();
    send(turn, assistant("msg_8", [{ type: "tool_use", id: "toolu_8", name: "Bash", input: { command: "sleep 1" } }]));
    await turn.translator.complete("failed", "bad", { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 6 }, "hi", "shown");

    assert.deepEqual(turn.events.map((event) => event.type === "agent_event" ? event.payload.type : event.type), [
        "turn.started",
        "item.started",
        "item.completed",
        "usage.updated",
        "record_turn",
        "turn.completed",
        "agent_done",
    ]);

    const events = turn.agentEvents();
    const completed = ofType(events, "item.completed");
    assert.equal(completed[0].item.id, "toolu_8");
    assert.equal(completed[0].item.status, "failed");

    const usage = ofType(events, "usage.updated");
    assert.deepEqual(usage[0].usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 0 });

    assert.deepEqual(turn.turns[0].turn, { id: "turn-1", status: "failed", error: { message: "bad" }, input: "hi", messageText: "shown" });

    const turnCompleted = ofType(events, "turn.completed");
    assert.equal(turnCompleted[0].status, "failed");

    const last = turn.events.at(-1);
    assert.equal(last?.type, "agent_done");
    assert.equal(last?.payload.status, "failed");
});

test("maps compact boundary to a context compaction item", () => {
    const turn = createTurn();
    send(turn, { type: "system", subtype: "compact_boundary", uuid: "u1" });

    const completed = ofType(turn.agentEvents(), "item.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].item.id, "u1");
    assert.equal(completed[0].item.type, "context_compaction");
});

test("logs Infinite Canvas MCP status only when it is not connected", () => {
    const failed = createTurn();
    send(failed, { type: "system", subtype: "init", mcp_servers: [{ name: "infinite-canvas", status: "failed" }] });
    const logs = ofType(failed.events, "agent_log");
    assert.equal(logs.length, 1);
    assert.ok(logs[0].payload.text.includes("failed"));

    const connected = createTurn();
    send(connected, { type: "system", subtype: "init", mcp_servers: [{ name: "infinite-canvas", status: "connected" }] });
    assert.equal(ofType(connected.events, "agent_log").length, 0);
});
