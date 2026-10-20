import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalSession } from "../src/session.ts";
import type { PersistedGoalState } from "../src/state.ts";

function fixture() {
	const entries: PersistedGoalState[] = [];
	const api = {
		on() {},
		appendEntry: (_type: string, data: PersistedGoalState) => entries.push(data),
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, mode: "json" } as ExtensionContext;
	return { session: createGoalSession(api), ctx, entries };
}

test("session operations persist transitions without exposing mutable goal state", () => {
	const { session, ctx, entries } = fixture();
	const created = session.set("Original", 1000, ctx);
	created.objective = "Changed through returned value";
	const snapshot = session.snapshot()!;
	snapshot.status = "complete";
	assert.equal(session.snapshot()!.objective, "Original");
	assert.equal(session.snapshot()!.status, "active");
	assert.equal(entries[0].goal!.objective, "Original");

	session.edit("Edited", ctx);
	assert.equal(entries[0].goal!.objective, "Original", "earlier snapshots remain independent");
	assert.equal(session.pause(ctx).status, "paused");
	assert.equal(session.resume(ctx).status, "active");
	assert.equal(session.finish("complete", ctx).status, "complete");
	assert.equal(session.clear(ctx), true);
	assert.equal(session.snapshot(), null);
	assert.deepEqual(entries.map(entry => entry.action), ["set", "edit", "status", "status", "status", "clear"]);
	assert.equal(entries.at(-1)!.goal, null);
});

test("rejected session operations do not persist or turn stopped goals into success", () => {
	const { session, ctx, entries } = fixture();
	assert.throws(() => session.resume(ctx), /no goal exists/);
	session.set("Original", undefined, ctx);
	assert.throws(() => session.edit("  ", ctx), /must not be empty/);
	assert.equal(entries.length, 1);
	assert.equal(session.snapshot()!.objective, "Original");
	session.pause(ctx);
	assert.throws(() => session.finish("complete", ctx), /Only an active/);
	assert.equal(entries.length, 2);
	assert.equal(session.snapshot()!.status, "paused");
});
