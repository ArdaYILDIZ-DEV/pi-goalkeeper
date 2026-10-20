import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RESPONSES, restoreGoal, retryDelay, usageTokens, validateObjective, validateTokenBudget, waitForRetry } from "../src/state.ts";

const saved = () => ({ version: 3, goal: { id: "g", objective: "Verify the work", status: "active", tokensUsed: 27, responsesUsed: 12, errorRetries: 3, timeUsedSeconds: 5, createdAt: 1, updatedAt: 2 } });

test("budget counts input, cache writes and output without subtracting cache reads", () => {
	assert.equal(usageTokens({ input: 1000, cacheRead: 5000, cacheWrite: 300, output: 200, totalTokens: 6500 }), 1500);
	assert.equal(usageTokens({ input: 0, cacheWrite: 0, output: 0, totalTokens: 900 }), 0);
	for (const usage of [undefined, {}, { input: -1, cacheWrite: 0, output: 0 }, { input: 1, output: 1 }, { input: NaN, cacheWrite: 0, output: 1 }]) assert.equal(usageTokens(usage), null);
});

test("restore preserves counters but never starts work", () => {
	const goal = restoreGoal(saved())!;
	assert.equal(goal.status, "paused");
	assert.equal(goal.responsesUsed, 12);
	assert.equal(goal.errorRetries, 3);
	assert.equal(goal.tokensUsed, 27);
	assert.equal(goal.recoveryReason, undefined);
	assert.equal(MAX_RESPONSES, 50);
});

test("old, unknown and corrupt state cannot become an active unlimited goal", () => {
	for (const version of [2, 4, undefined]) {
		const goal = restoreGoal({ ...saved(), version })!;
		assert.equal(goal.status, "paused");
		assert.match(goal.recoveryReason!, /Historical usage/);
	}
	for (const key of ["tokensUsed", "responsesUsed", "errorRetries", "timeUsedSeconds"]) {
		const data = saved();
		Object.assign(data.goal, { [key]: -1 });
		assert.ok(restoreGoal(data)?.recoveryReason);
	}
	assert.equal(restoreGoal({ version: 3, goal: { ...saved().goal, tokenBudget: 0 } }), null);
	assert.equal(restoreGoal({ version: 3, goal: null }), null);
	assert.equal(restoreGoal({ version: 3, goal: { ...saved().goal, objective: "" } }), null);
});

test("objective and budget validation rejects malformed input", () => {
	assert.equal(validateObjective("  Do it  "), "Do it");
	assert.throws(() => validateObjective(" "));
	assert.throws(() => validateObjective("😀".repeat(5001)));
	assert.equal(validateObjective("😀".repeat(5000)).length, 10000);
	for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateTokenBudget(value));
});

test("retry backoff is capped and waiting is cancellable", async () => {
	assert.deepEqual(Array.from({ length: 10 }, (_, n) => retryDelay(n)), [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000]);
	const controller = new AbortController();
	const wait = waitForRetry(30_000, controller.signal);
	controller.abort();
	assert.equal(await wait, false);
	assert.equal(await waitForRetry(1, controller.signal), false);
	assert.equal(await waitForRetry(1, new AbortController().signal), true);
});
