import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../src/state.ts";
import { createGoalStatus } from "../src/status.ts";

function fixture() {
	const labels: (string | undefined)[] = [];
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { setStatus: (_key: string, label: string | undefined) => labels.push(label), theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	const goal: Goal = { id: "g", objective: "Work", status: "active", tokensUsed: 0, responsesUsed: 0, errorRetries: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
	return { ctx, goal, labels };
}

test("elapsed footer refreshes snapshots without accumulating timers and stops idempotently", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { ctx, goal, labels } = fixture();
	const status = createGoalStatus(() => ({ ...goal }));
	status.update(ctx);
	status.update(ctx);
	assert.equal(labels.length, 2);
	goal.timeUsedSeconds = 3;
	t.mock.timers.tick(1000);
	assert.equal(labels.length, 3);
	assert.match(labels.at(-1)!, /3s/);
	status.stop();
	status.stop();
	t.mock.timers.tick(2000);
	assert.equal(labels.length, 3);
});

test("budgeted, paused, cleared and headless states stop the elapsed refresh", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	for (const transition of ["budget", "paused", "clear", "headless"] as const) {
		const { ctx, goal, labels } = fixture();
		let current: Goal | null = goal;
		const status = createGoalStatus(() => current);
		status.update(ctx);
		if (transition === "budget") { goal.tokenBudget = 1000; goal.tokensUsed = 200; }
		if (transition === "paused") goal.status = "paused";
		if (transition === "clear") current = null;
		if (transition === "headless") { ctx.hasUI = false; }
		status.update(ctx);
		const count = labels.length;
		t.mock.timers.tick(2000);
		assert.equal(labels.length, count, transition);
		if (transition === "budget") assert.match(labels.at(-1)!, /200 \/ 1K/);
		if (transition === "clear") assert.equal(labels.at(-1), undefined);
		status.stop();
	}
});

test("an existing refresh uses the latest UI context, not a stale session footer", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const first = fixture();
	const next = fixture();
	const status = createGoalStatus(() => first.goal);
	status.update(first.ctx);
	status.update(next.ctx);
	t.mock.timers.tick(1000);
	assert.equal(first.labels.length, 1);
	assert.equal(next.labels.length, 2);
	status.stop();
});
