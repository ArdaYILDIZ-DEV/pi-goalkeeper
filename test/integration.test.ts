import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	fauxAssistantMessage, fauxProvider, fauxToolCall,
	InMemoryCredentialStore, InMemoryModelsStore,
	type AssistantMessage, type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSessionEvent, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { PersistedGoalState } from "../src/state.ts";

const extensionPath = process.env.GOALKEEPER_EXTENSION_PATH ?? fileURLToPath(new URL("../src/index.ts", import.meta.url));
const call = (name: string, args: Parameters<typeof fauxToolCall>[1] = {}) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function harness(responses: FauxResponseStep[], options: { observer?: ExtensionFactory; nativeRetry?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "goalkeeper-sdk-"));
	try {
		const faux = fauxProvider({ tokensPerSecond: 0 });
		faux.setResponses(responses);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: options.nativeRetry ?? true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 10 },
		});
		const agentDir = join(root, "agent");
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true,
			additionalExtensionPaths: [extensionPath],
			extensionFactories: options.observer ? [options.observer] : [],
			// Observe the boundary before Goalkeeper enters its awaited backoff.
			extensionsOverride: base => ({ ...base, extensions: [...base.extensions].reverse() }),
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(root);
		const { session, extensionsResult } = await createAgentSession({
			cwd: root, agentDir, modelRuntime, model: faux.getModel(),
			settingsManager, sessionManager, resourceLoader,
			tools: ["create_goal", "get_goal", "update_goal"],
		});
		try {
			assert.deepEqual(extensionsResult.errors, []);
			assert.equal(extensionsResult.extensions.length, options.observer ? 2 : 1);
			await session.bindExtensions({});
		} catch (error) {
			session.dispose();
			throw error;
		}
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		return {
			session, sessionManager, faux, events,
			async close() {
				try {
					await session.abort();
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} finally {
					session.dispose();
					await rm(root, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function latestGoal(h: Awaited<ReturnType<typeof harness>>) {
	const entry = h.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "goal");
	assert.ok(entry && entry.type === "custom");
	const state = entry.data as PersistedGoalState;
	assert.ok(state.goal);
	return state.goal;
}

function assistants(events: AgentSessionEvent[]): AssistantMessage[] {
	return events.flatMap(event => event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []);
}

// These tests load the actual extension and execute validated tools through Pi's
// agent loop. Only the provider, credentials/catalogs, settings and session are fake/in-memory.
test("real SDK: mid-run creation excludes its own response and completion includes its tool-calling response", { timeout: 20_000 }, async () => {
	const h = await harness([
		call("create_goal", { objective: "Complete the explicitly requested integration goal", token_budget: 100_000 }),
		call("get_goal"),
		call("update_goal", { status: "complete" }),
		fauxAssistantMessage("The goal is complete; here is the final report."),
	]);
	try {
		await h.session.prompt("Explicitly create the integration goal, inspect it, complete it, and report.");
		assert.equal(h.faux.state.callCount, 4);
		const messages = assistants(h.events);
		assert.equal(messages.length, 4);
		const goal = latestGoal(h);
		assert.equal(goal.status, "complete");
		assert.equal(goal.responsesUsed, 2);
		const charged = messages.slice(1, 3).reduce((sum, message) =>
			sum + message.usage.input + message.usage.cacheWrite + message.usage.output, 0);
		assert.ok(charged > 0);
		assert.equal(goal.tokensUsed, charged);
		const toolResults = h.session.messages.filter(message => message.role === "toolResult");
		assert.deepEqual(toolResults.map(message => message.toolName), ["create_goal", "get_goal", "update_goal"]);
		assert.ok(toolResults.every(message => !message.isError));
		const completed = toolResults[2].content.find(block => block.type === "text");
		assert.ok(completed?.type === "text");
		assert.match(completed.text, /Goalkeeper goal achieved/);
		assert.match(completed.text, new RegExp(`tokens used: ${charged} of 100000`));
	} finally { await h.close(); }
});

test("real SDK: response limit stops an internal tool/model loop without another model request", { timeout: 20_000 }, async () => {
	const h = await harness([
		call("create_goal", { objective: "Exercise the response allowance" }),
		...Array.from({ length: 51 }, () => call("get_goal")),
	]);
	try {
		await h.session.prompt("Explicitly create the goal, then inspect it repeatedly.");
		assert.equal(h.faux.state.callCount, 51); // Creation plus the 50 charged responses.
		assert.equal(h.faux.getPendingResponseCount(), 1);
		assert.equal(latestGoal(h).responsesUsed, 50);
		assert.equal(latestGoal(h).status, "paused");
		assert.ok(h.events.some(event => event.type === "agent_end"));
	} finally { await h.close(); }
});

test("real SDK: native transient-error retry succeeds before Goalkeeper needs an extra retry", { timeout: 20_000 }, async () => {
	const h = await harness([
		call("create_goal", { objective: "Recover through native retry" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		call("update_goal", { status: "complete" }),
		fauxAssistantMessage("Completed after the native retry."),
	]);
	try {
		await h.session.prompt("Explicitly create this goal and mark it complete when done.");
		assert.equal(h.faux.state.callCount, 4);
		assert.ok(h.events.some(event => event.type === "auto_retry_start"));
		assert.ok(h.events.some(event => event.type === "auto_retry_end" && event.success));
		assert.equal(latestGoal(h).status, "complete");
		assert.equal(latestGoal(h).errorRetries, 0);
	} finally { await h.close(); }
});

test("real SDK: abort during Goalkeeper error backoff settles paused without starting the proposed retry", { timeout: 20_000 }, async t => {
	let resolveBoundary!: (signal: AbortSignal | undefined) => void;
	const boundary = new Promise<AbortSignal | undefined>(resolve => { resolveBoundary = resolve; });
	const h = await harness([
		call("create_goal", { objective: "Abort this goal during error backoff" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "Integration failure, not a native retry" }),
		fauxAssistantMessage("This request must not start."),
	], {
		nativeRetry: false,
		observer: pi => {
			pi.on("agent_before_settle", (event, ctx) => {
				if (event.outcome === "error") resolveBoundary(ctx.signal);
			});
		},
	});
	try {
		const run = h.session.prompt("Explicitly create this goal, then attempt work.");
		const signal = await boundary;
		// The pinned host clears activeRun before this boundary. Its missing
		// signal cannot interrupt Goalkeeper's timer; settlement still vetoes restart.
		assert.equal(signal, undefined);
		await delay(25);
		const started = performance.now();
		await h.session.abort();
		await run;
		t.diagnostic(`Abort during boundary backoff settled after ${Math.round(performance.now() - started)}ms; boundary ctx.signal was undefined.`);
		assert.equal(h.faux.state.callCount, 2);
		assert.equal(h.faux.getPendingResponseCount(), 1);
		assert.equal(latestGoal(h).status, "paused");
		assert.equal(latestGoal(h).errorRetries, 0);
		assert.ok(h.events.some(event => event.type === "agent_settled" && event.aborted));
	} finally { await h.close(); }
});

test("real SDK: plain progress crosses a real boundary using a preserved entry and goal continuation", { timeout: 20_000 }, async () => {
	let progressBoundaryCanContinue: boolean | undefined;
	let sawContinuationContext = false;
	const h = await harness([
		call("create_goal", { objective: "Finish after reporting partial progress" }),
		fauxAssistantMessage("Partial progress only; required work remains."),
		context => {
			sawContinuationContext = context.messages.some(message => message.role === "user" &&
				JSON.stringify(message.content).includes("Continue working toward the active thread goal"));
			return call("update_goal", { status: "complete" });
		},
		fauxAssistantMessage("All required work is now complete."),
	], {
		observer: pi => {
			pi.on("agent_before_settle", event => {
				if (event.context.llmMessages.some(message => message.role === "assistant" &&
					JSON.stringify(message.content).includes("Partial progress only")) && progressBoundaryCanContinue === undefined) {
					progressBoundaryCanContinue = event.context.canContinue;
					return { entries: [...event.entries, { type: "custom", customType: "integration-boundary-marker", data: { preserved: true } }] };
				}
			});
		},
	});
	try {
		await h.session.prompt("Explicitly create this goal, report partial progress, then finish it.");
		assert.equal(progressBoundaryCanContinue, false); // Plain assistant text alone cannot continue.
		assert.equal(sawContinuationContext, true); // The added custom message supplies valid continuation context.
		assert.equal(h.faux.state.callCount, 4);
		assert.equal(latestGoal(h).status, "complete");
		assert.equal(latestGoal(h).responsesUsed, 2);
		const entries = h.sessionManager.getBranch();
		assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "goal-continuation").length, 1);
		assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "integration-boundary-marker").length, 1);
	} finally { await h.close(); }
});

test("real SDK: an accepted Goalkeeper error retry is counted at the next run and preserves boundary entries", { timeout: 20_000 }, async t => {
	let retriesAtRestart: number | undefined;
	let sawContinuationContext = false;
	const h = await harness([
		call("create_goal", { objective: "Recover through one Goalkeeper retry" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "Failure requiring a Goalkeeper retry" }),
		context => {
			retriesAtRestart = latestGoal(h).errorRetries;
			sawContinuationContext = context.messages.some(message => message.role === "user" &&
				JSON.stringify(message.content).includes("Continue working toward the active thread goal"));
			return call("update_goal", { status: "complete" });
		},
		fauxAssistantMessage("Completed after the Goalkeeper retry."),
	], {
		nativeRetry: false,
		observer: pi => {
			pi.on("agent_before_settle", event => {
				if (event.outcome === "error") {
					return { entries: [...event.entries, { type: "custom", customType: "integration-retry-marker", data: { preserved: true } }] };
				}
			});
		},
	});
	try {
		const started = performance.now();
		await h.session.prompt("Explicitly create this goal and recover from the error to finish it.");
		t.diagnostic(`Accepted Goalkeeper retry and completion took ${Math.round(performance.now() - started)}ms.`);
		assert.equal(h.faux.state.callCount, 4);
		assert.equal(retriesAtRestart, 1);
		assert.equal(sawContinuationContext, true);
		assert.equal(latestGoal(h).status, "complete");
		assert.equal(latestGoal(h).errorRetries, 0); // Successful settlement resets consecutive errors.
		assert.equal(h.events.some(event => event.type === "auto_retry_start"), false);
		assert.equal(h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "integration-retry-marker").length, 1);
	} finally { await h.close(); }
});

test("real SDK: response-bound abort preserves a pending user follow-up", { timeout: 20_000 }, async () => {
	const queued = "User follow-up must survive the response allowance stop.";
	const h = await harness([
		call("create_goal", { objective: "Reach the limit with a pending user message" }),
		...Array.from({ length: 49 }, () => call("get_goal")),
		async () => {
			await h.session.followUp(queued);
			return call("get_goal");
		},
		fauxAssistantMessage("Must not consume the queued user request automatically."),
	]);
	try {
		await h.session.prompt("Explicitly create this goal and inspect it repeatedly.");
		assert.equal(h.faux.state.callCount, 51);
		assert.equal(latestGoal(h).responsesUsed, 50);
		assert.equal(latestGoal(h).status, "paused");
		assert.deepEqual(h.session.getFollowUpMessages(), [queued]);
		assert.equal(h.session.pendingMessageCount, 1);
		assert.equal(h.faux.getPendingResponseCount(), 1);
	} finally { await h.close(); }
});
