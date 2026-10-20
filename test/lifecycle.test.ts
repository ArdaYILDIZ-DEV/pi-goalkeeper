import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalkeeper from "../src/index.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Tool = { name: string; execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<{ details: { goal: Record<string, unknown> | null } }> };
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

function harness() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const sent: unknown[] = [];
	let aborted = 0;
	let pending = false;
	let idle = false;
	const signal = new AbortController();
	const ctx = {
		mode: "json", hasUI: false, signal: signal.signal,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getBranch: () => entries, getSessionId: () => "test-session" },
		isIdle: () => idle, hasPendingMessages: () => pending, abort: () => { aborted++; signal.abort(); },
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: unknown) => sent.push(message),
	} as unknown as ExtensionAPI;
	goalkeeper(api);
	const emit = async (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx);
	const tool = (name: string, params: unknown = {}) => tools.get(name)!.execute("call", params, undefined, undefined, ctx);
	const status = async () => (await tool("get_goal")).details.goal!;
	const boundary = (outcome = "completed", extra: Record<string, unknown> = {}) => emit("agent_before_settle", { outcome, entries: [], continue: false, context: { pendingMessages: [], canContinue: false }, ...extra });
	const response = async (usage: unknown = { input: 2, cacheWrite: 3, cacheRead: 100, output: 5 }) => {
		await emit("message_start", { message: { role: "assistant" } });
		await emit("message_end", { message: { role: "assistant", usage } });
	};
	return { emit, tool, status, boundary, response, entries, sent, ctx, signal, aborted: () => aborted, command: (args: string) => commands.get("goal")!.handler(args, ctx), setPending: (value: boolean) => { pending = value; }, setIdle: (value: boolean) => { idle = value; } };
}

test("normal settlement appends one continuation and preserves earlier drafts", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Do work" });
	const earlier = { type: "custom", customType: "other", data: 1 };
	const result = await h.boundary("completed", { entries: [earlier] }) as { entries: unknown[]; continue: boolean };
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 2);
	assert.equal(result.entries[0], earlier);
	assert.equal(h.sent.length, 0);
	assert.equal(await h.boundary("completed", { continue: true }), undefined);
	h.setPending(true);
	assert.equal(await h.boundary(), undefined);
});

test("create-calling response is excluded; completion-calling response is included exactly once", async () => {
	const h = harness();
	await h.emit("message_start", { message: { role: "assistant" } });
	await h.emit("message_end", { message: { role: "assistant", usage: { input: 500, cacheWrite: 0, output: 0 } } });
	await h.tool("create_goal", { objective: "Do work" });
	await h.response();
	await h.tool("update_goal", { status: "complete" });
	await h.emit("agent_end", { messages: [] });
	await h.response();
	const goal = await h.status();
	assert.equal(goal.tokensUsed, 10);
	assert.equal(goal.responsesUsed, 1);
	assert.equal(goal.status, "complete");
	assert.equal(await h.boundary(), undefined);
});

test("budget exhaustion stops at turn boundary; edit and resume do not reset consumption", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Work", token_budget: 10 });
	await h.response();
	assert.equal((await h.status()).status, "budgetLimited");
	await h.emit("turn_end");
	assert.equal(h.aborted(), 1);
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	assert.equal((await h.status()).status, "budgetLimited");
	await h.command("resume");
	assert.equal((await h.status()).status, "budgetLimited");
	assert.equal((await h.status()).tokensUsed, 10);
	assert.equal(await h.boundary(), undefined);
	await assert.rejects(h.tool("update_goal", { status: "complete" }), /Only an active/);
});

test("response bound stops even an unlimited goal and explicit resume resets only allowances", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Work" });
	for (let i = 0; i < 50; i++) await h.response();
	assert.equal((await h.status()).status, "paused");
	await h.emit("turn_end");
	assert.equal(h.aborted(), 1);
	await h.command("resume");
	assert.equal((await h.status()).responsesUsed, 0);
	assert.equal((await h.status()).tokensUsed, 500);
});

test("missing budget usage stops safely, even after reload", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Work", token_budget: 100 });
	await h.response({ input: 1 });
	assert.equal((await h.status()).status, "paused");
	assert.match(String((await h.status()).recoveryReason), /usage/);
	await h.emit("session_start");
	await h.command("resume");
	assert.equal((await h.status()).status, "paused");
});

test("abort never opens a confirmation or auto-resumes; blocked stops immediately", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Work" });
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	assert.equal((await h.status()).status, "paused");
	assert.equal(await h.boundary(), undefined);
	await h.command("resume");
	await h.tool("update_goal", { status: "blocked" });
	assert.equal((await h.status()).status, "blocked");
	assert.equal(await h.boundary(), undefined);
});

test("error retries are capped at ten accepted starts, success resets consecutive errors", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.tool("create_goal", { objective: "Work" });
	for (let i = 0; i < 10; i++) {
		const promise = h.boundary("error");
		t.mock.timers.tick(30_000);
		const result = await promise as { continue: boolean };
		assert.equal(result.continue, true);
		assert.equal((await h.status()).errorRetries, i);
		await h.emit("agent_start");
		assert.equal((await h.status()).errorRetries, i + 1);
	}
	assert.equal(await h.boundary("error"), undefined);
	assert.equal((await h.status()).status, "paused");
	await h.command("resume");
	assert.equal((await h.status()).errorRetries, 0);
	const retry = h.boundary("error");
	t.mock.timers.tick(2000);
	await retry;
	await h.emit("agent_start");
	await h.boundary("completed");
	assert.equal((await h.status()).errorRetries, 0);
});

test("pause, clear, new input, abort, and goal replacement cancel in-flight retry", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const action of ["pause", "clear", "input", "abort", "replace"]) {
		const h = harness();
		await h.tool("create_goal", { objective: "Work" });
		const promise = h.boundary("error");
		if (action === "input") await h.emit("input");
		else if (action === "abort") h.signal.abort();
		else if (action === "replace") { await h.command("clear"); await h.tool("create_goal", { objective: "Different work" }); }
		else await h.command(action);
		assert.equal(await promise, undefined, action);
		t.mock.timers.tick(30_000);
		if (action !== "clear") assert.equal((await h.status()).errorRetries, 0);
	}
});

test("reload and branch restore preserve counters, pause active state, and never trigger work", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "First branch" });
	await h.response();
	const branch = [...h.entries];
	await h.command("clear");
	await h.tool("create_goal", { objective: "Other branch" });
	h.entries.splice(0, h.entries.length, ...branch);
	await h.emit("session_tree");
	assert.equal((await h.status()).objective, "First branch");
	assert.equal((await h.status()).status, "paused");
	assert.equal((await h.status()).responsesUsed, 1);
	assert.equal(h.sent.filter((item: unknown) => (item as { customType?: string }).customType === "goal-continuation").length, 0);
});

test("a previous goal's limit cannot abort its replacement", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Old", token_budget: 1 });
	await h.response();
	await h.command("clear");
	await h.tool("create_goal", { objective: "New" });
	await h.emit("turn_end");
	assert.equal(h.aborted(), 0);
	assert.equal((await h.status()).status, "active");
});

test("editing a budget-limited goal cannot reactivate it; cancelled replacement preserves state", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Original", token_budget: 10 });
	await h.response();
	Object.assign(h.ctx, { hasUI: true });
	Object.assign(h.ctx.ui, {
		theme: { fg: (_color: string, text: string) => text },
		editor: async () => "Edited objective",
		confirm: async () => false,
	});
	await h.command("edit");
	assert.equal((await h.status()).objective, "Edited objective");
	assert.equal((await h.status()).status, "budgetLimited");
	assert.equal((await h.status()).tokensUsed, 10);
	await h.command("Replacement cancelled");
	assert.equal((await h.status()).objective, "Edited objective");
	await h.command("resume");
	assert.equal((await h.status()).status, "budgetLimited");
});

test("busy commands never leave stale continuations in Pi queues", async () => {
	const h = harness();
	await h.command("Work");
	await h.command("pause");
	assert.equal(h.sent.filter(item => (item as { customType?: string }).customType === "goal-continuation").length, 0);
});
